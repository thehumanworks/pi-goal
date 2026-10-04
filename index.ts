#!/usr/bin/env -S bun
import type {
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import fs from "node:fs";
import path from "node:path";
import {
  createGoalManager,
  type GoalJson,
  type GoalTask,
  type GoalToolDetails,
} from "./goalManager.ts";
import {
  elapsedDuration,
  formatElapsedDuration,
  normalizeGoalText,
  now,
} from "./formatters.ts";
import {
  formatGoalCompletionEvidence,
  formatGoalCompletionGateMessage,
  formatGoalMissionPrompt,
  formatGoalState,
} from "./prompts.ts";

import {
  GOAL_VERIFIER_CHANNEL, type CompletionReview, type ReviewCompletion,
  type ValidationEvidence, type VerifierDiscovery,
} from "./verification.ts";

const GOALS_DIR = path.join(process.env.HOME!, ".pi", "agent", "goals");
const GOAL_STATUS_UPDATE_INTERVAL_MS = 1000;
const GOAL_STATE_CUSTOM_TYPE = "goal-state";
const GOAL_COMPLETION_GATE_CUSTOM_TYPE = "goal-completion-gate";
const GOAL_SCOPE_CUSTOM_TYPE = "goal-scope";
const GOAL_STATUS_KEY = "goal";
// Brief, neutral text that triggers a follow-up turn after agent_end. The
// actual completion-gate prose is delivered via the `context` handler as a
// custom-role message (the same channel that reliably ferries goal_state to
// the LLM across all providers, including cursor-agent which filters
// synthetic user-message bodies out of the user_query envelope).
const GOAL_GATE_TRIGGER_TEXT =
  "Reached end of agent run with active goal — running completion gate.";
// Bright magenta. The theme has no semantic magenta token, so we use a raw
// ANSI escape to keep the status line magenta regardless of the active theme.
const GOAL_STATUS_COLOR = "\x1b[95m";
const RESET_FOREGROUND_COLOR = "\x1b[39m";

const GOAL_TASK_ACTIONS = ["list", "add", "check", "uncheck"] as const;

// Gate-pass circuit breaker. The completion gate re-fires after every
// agent_end on a still-active goal; without a guard, an agent that keeps
// stopping (or keeps re-calling goal_complete against an always-red exec gate)
// loops forever and burns tokens. We count *consecutive* gate passes and reset
// the counter on genuine code progress (an edit/write tool running), so
// productive multi-turn work is never penalised — only stuck/looping turns
// accumulate. At GOAL_GATE_ESCALATE_AT we raise the thinking level once; at the
// max (configurable via --goal-max-gate-passes) we abort to stop the loop.
const GOAL_GATE_ESCALATE_AT = 3;
const GOAL_GATE_DEFAULT_MAX_PASSES = 6;
const GOAL_PROGRESS_TOOLS = new Set(["edit", "write"]);
const GOAL_MAX_GATE_PASSES_FLAG = "goal-max-gate-passes";
const GOAL_NO_EXEC_GATE_FLAG = "goal-no-exec-gate";

// Scope enforcement. The most common coding-agent failure is editing files
// outside the task (scope creep). The agent declares an allow/deny path scope
// via goal_scope; writes to out-of-scope paths are hard-blocked at the
// tool_call hook before they run (Spec-Driven Development / Codex boundaries).
const GOAL_SCOPE_ACTIONS = ["set", "list", "clear"] as const;
const GOAL_WRITE_TOOLS = new Set(["edit", "write"]);

// Minimal, dependency-free glob → RegExp (supports ** and *). Paths are
// normalised to forward slashes and stripped of a leading "./" before matching.
const globToRegExp = (glob: string): RegExp => {
  const normalized = glob.trim().replace(/^\.\//, "");
  let out = "";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!;
    if (char === "*" && normalized[i + 1] === "*") {
      if (normalized[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (char === "*") {
      out += "[^/]*";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/, "\\$&");
    }
  }
  return new RegExp("^" + out + "$");
}

const normalizeScopePath = (filePath: string): string =>
  filePath.replace(/\\/g, "/").replace(/^\.\//, "");

const pathMatchesAny = (filePath: string, patterns: string[]): boolean => {
  const normalized = normalizeScopePath(filePath);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
};

// Exec-verified completion gate. Before goal_complete is accepted, run the
// project's own verification commands (tests / typecheck / lint) and refuse
// completion if any are red — completion becomes machine-checked exit codes,
// not self-narrated prose (SWE-bench fail-to-pass / Factory exit-code gate).
const GOAL_EXEC_TIMEOUT_MS = 120_000;
const GOAL_EXEC_OUTPUT_CAP = 4_000;

const readJsonSafe = (filePath: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

// Discover verification commands for the exec gate, in priority order:
//   1. .pi-goal.json { "validate": ["cmd", ...] } — explicit shell commands.
//   2. package.json scripts (typecheck, test, lint) — the raw script command
//      is run directly (pm-agnostic; no `npm run` wrapper guessing).
// Returns [] when nothing is discoverable; the gate then degrades to a warning.
const discoverValidationCommands = (cwd: string): string[] => {
  const config = readJsonSafe(path.join(cwd, ".pi-goal.json"));
  const declared = config?.validate;
  if (Array.isArray(declared)) {
    return declared.filter(
      (c): c is string => typeof c === "string" && c.trim().length > 0,
    );
  }

  const pkg = readJsonSafe(path.join(cwd, "package.json"));
  const scripts =
    pkg && typeof pkg.scripts === "object" && pkg.scripts ?
      (pkg.scripts as Record<string, unknown>)
    : {};
  const commands: string[] = [];
  for (const name of ["typecheck", "test", "lint"]) {
    const body = scripts[name];
    if (typeof body === "string" && body.trim().length > 0) commands.push(body);
  }
  return commands;
};

// Structured-evidence schema: each field is required and its description is
// the actual gate. The LLM API enforces presence of the fields; the field
// descriptions enforce the *quality* of what goes inside. There is no
// post-hoc text-matching of agent responses anywhere — the schema itself is
// the audit, which is the only enforcement mechanism that is not fragile.
const GoalCompleteParams = Type.Object({
  summary: Type.String({
    description:
      "One-paragraph plain-language headline of what was accomplished. Detail goes in the evidence fields below; this is the human-readable summary only.",
  }),
  requirementsCovered: Type.String({
    description:
      "Restate the user's explicit requirements (and important implicit ones) as a bulleted list, and after each one cite the concrete artifact that satisfies it: file path with line range, exact test name, exact tool/command output, screenshot reference, etc. 'Yes', 'done', and other vague answers are unacceptable. If a requirement was deferred, partially met, or reinterpreted, say so explicitly with the reason.",
  }),
  verificationsRun: Type.String({
    description:
      "Quote the exact commands you ran to verify correctness (e.g. `bun test`, `tsc --noEmit`, lint, app smoke test) and the exact result for each (e.g. '22 pass, 0 fail, 101 expect()'). For every applicable check that you did NOT run, name the check and explain why. Do not claim a check passed without an artifact in this field.",
  }),
  taskEvidence: Type.String({
    description:
      "For each tracked goal_task, cite the concrete evidence that justifies marking it complete (file:line, test name, command output). If no goal_tasks are tracked, justify completion of the overall goal without them and explain why per-task tracking was not used.",
  }),
  shortcutsConsidered: Type.String({
    description:
      "Name the shortcuts you considered taking (e.g. 'skip writing a regression test', 'assume existing logic covers edge case X', 'rely on memory for the SDK API instead of reading docs', 'mark a task complete from inference rather than verification') and for each one state whether you took it or rejected it and why. An empty, generic, or hand-wavy answer here is itself a signal that the goal is not yet complete — keep working instead of completing.",
  }),
});

const GoalTaskParams = Type.Object({
  action: StringEnum(GOAL_TASK_ACTIONS),
  text: Type.Optional(
    Type.String({ description: "Task text. Required when action is add." }),
  ),
  id: Type.Optional(
    Type.Number({
      description: "Task id. Required when action is check or uncheck.",
    }),
  ),
});

const GoalScopeParams = Type.Object({
  action: StringEnum(GOAL_SCOPE_ACTIONS),
  allow: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Glob patterns (relative to cwd) for paths the agent MAY modify. When non-empty, writes to paths outside this allowlist are blocked. Used with action 'set'.",
    }),
  ),
  deny: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Glob patterns for paths the agent must NOT modify; takes precedence over allow. Used with action 'set'.",
    }),
  ),
});

// Re-exported so existing imports of this module keep working.
export { normalizeGoalText };

export default function(pi: ExtensionAPI) {
  const goalManager = createGoalManager(GOALS_DIR);
  let goal: GoalJson | null = null;
  let goalSessionId: string | null = null;
  let goalStatusTimer: ReturnType<typeof setInterval> | null = null;
  let goalContinuationTimer: ReturnType<typeof setTimeout> | null = null;
  // Set in agent_end, consumed and cleared in the next `context` event.
  // Drives one-shot injection of the gate prose into the upcoming LLM call.
  let pendingGateInjection = false;
  // Consecutive gate passes since the last genuine code progress. Reset on
  // setGoal/adoptPersistedGoal and on edit/write tool execution.
  let gatePassCount = 0;
  // Validation commands for the exec-verified completion gate, discovered once
  // lazily (null = not yet probed).
  let validationCommands: string[] | null = null;
  let verifierBlock: { taskId?: number; report: string } | undefined;
  let rejectedToolBatch = false;
  let disposed = false;
  // In-memory scope for the active goal (session-scoped; re-declare after a
  // reload). allow: paths the agent may modify; deny: paths it must not.
  let goalScope: { allow: string[]; deny: string[] } = { allow: [], deny: [] };

  const colorizeGoalStatus = (text: string) =>
    `${GOAL_STATUS_COLOR}${text}${RESET_FOREGROUND_COLOR}`;

  const formatActiveGoalStatus = (activeGoal: GoalJson) =>
    colorizeGoalStatus(
      `Working towards a goal (${formatElapsedDuration(elapsedDuration(activeGoal))})`,
    );

  const formatCompletedGoalStatus = (completedGoal: GoalJson) =>
    colorizeGoalStatus(
      `Completed a goal (${formatElapsedDuration(completedGoal.totalDuration)})`,
    );

  const setGoalStatus = (ctx: ExtensionContext, text: string | undefined) => {
    ctx.ui.setStatus(GOAL_STATUS_KEY, text);
  };

  const clearGoalStatusTimer = () => {
    if (goalStatusTimer) {
      clearInterval(goalStatusTimer);
      goalStatusTimer = null;
    }
  };

  const clearGoalContinuationTimer = () => {
    if (goalContinuationTimer) {
      clearTimeout(goalContinuationTimer);
      goalContinuationTimer = null;
    }
  };

  const updateActiveGoalStatus = (ctx: ExtensionContext) => {
    if (!goal?.isActive) {
      clearGoalStatusTimer();
      return;
    }

    setGoalStatus(ctx, formatActiveGoalStatus(goal));
  };

  const startActiveGoalStatus = (ctx: ExtensionContext) => {
    clearGoalStatusTimer();
    updateActiveGoalStatus(ctx);
    if (!goal?.isActive) return;

    goalStatusTimer = setInterval(
      () => updateActiveGoalStatus(ctx),
      GOAL_STATUS_UPDATE_INTERVAL_MS,
    );
    goalStatusTimer.unref?.();
  };

  const saveGoal = async () => {
    if (!goal || !goalSessionId) return;
    goal.lastUpdatedAt = now();
    goal.totalDuration = elapsedDuration(goal);
    await goalManager.saveGoal(goalSessionId, goal);
  };

  // Atomically install a (sessionId, goal) pair: only update the cached
  // session id once the goal has been successfully created/persisted, and
  // cancel any pending completion-gate continuation that belongs to the
  // previous goal so it doesn't fire against the replacement.
  const setGoal = async (goalText: string, sessionId: string) => {
    const nextGoal = await goalManager.createGoal(sessionId, goalText);
    clearGoalContinuationTimer();
    pendingGateInjection = false;
    gatePassCount = 0;
    validationCommands = null;
    verifierBlock = undefined;
    rejectedToolBatch = false;
    goalScope = { allow: [], deny: [] };
    goal = nextGoal;
    goalSessionId = sessionId;
  };

  // Rehydrate a previously persisted goal into the in-memory cache without
  // mutating SQLite (used during session_start / reload / resume).
  const adoptPersistedGoal = (persistedGoal: GoalJson, sessionId: string) => {
    clearGoalContinuationTimer();
    pendingGateInjection = false;
    gatePassCount = 0;
    validationCommands = null;
    verifierBlock = undefined;
    rejectedToolBatch = false;
    goalScope = { allow: [], deny: [] };
    goal = persistedGoal;
    goalSessionId = sessionId;
  };

  // Evaluate a write target against the active scope. deny takes precedence;
  // a non-empty allowlist makes anything outside it out-of-scope. The path is
  // made cwd-relative first, since pi may hand the tools an absolute path while
  // scope globs are written relative to the project root.
  const evaluateScope = (
    rawPath: string,
    cwd: string,
  ): { blocked: boolean; reason?: string } => {
    let filePath = rawPath.replace(/\\/g, "/");
    const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalizedCwd && filePath.startsWith(normalizedCwd + "/")) {
      filePath = filePath.slice(normalizedCwd.length + 1);
    }
    // Collapse "." / ".." segments BEFORE matching, so a traversal like
    // "src/../../secret.ts" becomes "../secret.ts" and cannot sneak past an
    // "src/**" allowlist (whose regex `.*` would otherwise span the slashes).
    filePath = path.posix.normalize(filePath);
    if (goalScope.deny.length && pathMatchesAny(filePath, goalScope.deny)) {
      return {
        blocked: true,
        reason: `Path "${filePath}" is out of scope for this goal (matches a deny pattern). Do not modify it; if it is genuinely required, update the goal scope with goal_scope first.`,
      };
    }
    if (goalScope.allow.length && !pathMatchesAny(filePath, goalScope.allow)) {
      return {
        blocked: true,
        reason: `Path "${filePath}" is outside the declared in-scope allowlist (${goalScope.allow.join(", ")}). Stay within scope; if this file is genuinely required, extend the scope with goal_scope first.`,
      };
    }
    return { blocked: false };
  };

  const getMaxGatePasses = () => {
    const raw = pi.getFlag(GOAL_MAX_GATE_PASSES_FLAG);
    const parsed = typeof raw === "string" ? parseInt(raw, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ?
        parsed
      : GOAL_GATE_DEFAULT_MAX_PASSES;
  };

  // Run the discovered verification commands. Returns a blocking report (with
  // the failing command + truncated output) on the first non-zero exit, or
  // {blocked:false} when everything passes or no commands are discoverable.
  type GateResult =
    | { blocked: false; commandCount: number; results: ValidationEvidence[] }
    | { blocked: true; report: string };
  const runValidationGate = async (cwd: string): Promise<GateResult> => {
    if (validationCommands === null)
      validationCommands = discoverValidationCommands(cwd);
    if (validationCommands.length === 0)
      return { blocked: false, commandCount: 0, results: [] };

    const results: ValidationEvidence[] = [];
    for (const command of validationCommands) {
      // Prepend the project's local bin to PATH so package.json scripts and
      // .pi-goal.json commands can invoke locally-installed tools (jest, tsc,
      // eslint, vitest, …) the same way `npm run`/`bun run` would. Without
      // this, `bash -lc jest` fails with "command not found" (a non-zero exit
      // that would falsely block completion).
      const result = await pi.exec(
        "bash",
        ["-lc", `export PATH="$PWD/node_modules/.bin:$PATH"; ${command}`],
        { cwd, timeout: GOAL_EXEC_TIMEOUT_MS },
      );
      results.push({ command, code: result.code, killed: result.killed,
        stdout: result.stdout.slice(-GOAL_EXEC_OUTPUT_CAP), stderr: result.stderr.slice(-GOAL_EXEC_OUTPUT_CAP) });
      if (result.code !== 0) {
        const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
        const output =
          combined.length > GOAL_EXEC_OUTPUT_CAP ?
            combined.slice(-GOAL_EXEC_OUTPUT_CAP)
          : combined;
        return {
          blocked: true,
          report:
            `COMPLETION BLOCKED: verification command failed (exit ${result.code}` +
            `${result.killed ? ", timed out" : ""}):\n$ ${command}\n` +
            `${output || "(no output)"}\n\n` +
            `Fix the failure and call goal_complete again. Do not mark the goal ` +
            `complete while verification is red.`,
        };
      }
    }
    return { blocked: false, commandCount: validationCommands.length, results };
  };

  const getVerifier = (ctx: ExtensionContext): ReviewCompletion | undefined => {
    let review: ReviewCompletion | undefined;
    const discovery: VerifierDiscovery = {
      sessionId: ctx.sessionManager.getSessionId(),
      provide(candidate) { review = candidate; },
    };
    pi.events.emit(GOAL_VERIFIER_CHANNEL, discovery);
    if (!review) verifierBlock = undefined; // Disabled/uninstalled means original behavior.
    return review;
  };

  const rejectCompletion = (feedback: string, task?: GoalTask) => {
    const retry = task ? `Fix task #${task.id} and retry goal_task check for that id before completing any later task or the goal.`
      : "Fix the unmet requirements and retry goal_complete before moving on.";
    const report = `COMPLETION BLOCKED by verifier: ${feedback}\n\n${retry}`;
    verifierBlock = { taskId: task?.id, report };
    rejectedToolBatch = true;
    pendingGateInjection = true;
    return {
      content: [{ type: "text" as const, text: report }],
      details: { goal, error: "Completion blocked: verifier rejected", verification: { pass: false, feedback } },
    };
  };

  const reviewCompletion = async (
    review: ReviewCompletion, ctx: ExtensionContext, signal: AbortSignal | undefined,
    task?: GoalTask, evidence?: Record<string, string>, validationResults?: ValidationEvidence[],
  ) => {
    const reviewedGoal = goal!;
    const sessionId = goalSessionId;
    try {
      signal?.throwIfAborted();
      const request: CompletionReview = {
        cwd: ctx.cwd, goal: structuredClone(reviewedGoal), task: task && { ...task }, evidence,
        contract: {
          evidenceFields: Object.fromEntries(Object.entries(GoalCompleteParams.properties)
            .map(([name, schema]) => [name, (schema as { description?: string }).description ?? ""])),
          validationCommands: discoverValidationCommands(ctx.cwd),
        },
        validationResults,
        history: ctx.sessionManager.getBranch(), signal,
      };
      const verdict = await review(request);
      signal?.throwIfAborted();
      if (disposed || goal !== reviewedGoal || goalSessionId !== sessionId) {
        throw new Error("The goal/session changed during verification. Retry completion for the current goal.");
      }
      if (!verdict || typeof verdict.pass !== "boolean" || typeof verdict.feedback !== "string" || !verdict.feedback.trim()) {
        throw new Error("Verifier returned no valid verdict. Retry verification before completing this task.");
      }
      if (!verdict.pass) return rejectCompletion(verdict.feedback, task);
      if (verifierBlock?.taskId === task?.id) verifierBlock = undefined;
      return undefined;
    } catch (error) {
      // A late result must never mutate or reject a replacement goal/session.
      if (disposed || goal !== reviewedGoal || goalSessionId !== sessionId) throw error;
      return rejectCompletion(error instanceof Error ? error.message : String(error), task);
    }
  };

  const sendGoalUserMessage = (goalText: string, isIdle: boolean) => {
    // Never use a bare plain send (no deliverAs). In headless/print mode
    // (`pi -p`), ctx.isIdle() can report idle at session_start while a prompt
    // is already being processed; a plain send then async-rejects with "Agent
    // is already processing" (the rejection is not synchronously catchable —
    // see bindCore in pi-coding-agent's loader.js), so the run dies with zero
    // turns. Always specify a delivery mode: `followUp` triggers a turn when
    // genuinely idle and safely queues when busy; `steer` redirects a stream
    // that is actually in progress. This mirrors the agent_end gate's delivery.
    pi.sendUserMessage(goalText, { deliverAs: isIdle ? "followUp" : "steer" });
  };

  const noActiveGoal = () => ({
    content: [
      {
        type: "text" as const,
        text: "No active goal is configured for this session.",
      },
    ],
    details: { goal, error: "No active goal" } as GoalToolDetails,
  });

  pi.registerFlag("goal", {
    description:
      "define a target goal for the agent to achieve in a continuous loop",
    type: "string",
  });

  pi.registerFlag(GOAL_MAX_GATE_PASSES_FLAG, {
    description:
      "Hard-stop the goal completion gate after this many consecutive stuck passes (default 6).",
    type: "string",
  });

  pi.registerFlag(GOAL_NO_EXEC_GATE_FLAG, {
    description:
      "Disable the exec-verified completion gate (do not run test/lint/typecheck commands before accepting goal_complete).",
    type: "boolean",
  });

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();

    // Rehydrate any persisted goal first so reload/resume/restart preserve
    // the active goal, its tasks, and its in-memory cache. Without this the
    // very next `/goal` would silently overwrite the persisted record via
    // createGoal's INSERT...ON CONFLICT + DELETE FROM goal_tasks.
    try {
      const persistedGoal = await goalManager.loadGoal(sessionId);
      if (persistedGoal) {
        adoptPersistedGoal(persistedGoal, sessionId);
        if (persistedGoal.isActive) {
          startActiveGoalStatus(ctx);
        } else {
          setGoalStatus(ctx, formatCompletedGoalStatus(persistedGoal));
        }
      }
    } catch {
      // Persistence is best-effort: a failed load must not prevent the
      // session from starting. The user can always re-set the goal via /goal.
    }

    // An explicit `--goal` flag always wins over a previously persisted goal.
    const maybeGoal = pi.getFlag("goal");
    if (typeof maybeGoal === "string" && maybeGoal.length > 0) {
      const nextGoal = normalizeGoalText(maybeGoal);
      if (!nextGoal) return;
      await setGoal(nextGoal, sessionId);
      startActiveGoalStatus(ctx);
      sendGoalUserMessage(nextGoal, ctx.isIdle());
    }
  });

  pi.registerCommand("goal", {
    description: "Set or replace the active goal",
    handler: async (args, ctx) => {
      const nextGoal = normalizeGoalText(args);
      if (!nextGoal) {
        ctx.ui.notify("Usage: /goal <goal>", "warning");
        return;
      }

      const currentGoalText = goal?.goal;
      if (currentGoalText) {
        if (!ctx.hasUI) {
          return;
        }

        const confirmed = await ctx.ui.confirm(
          "Replace current goal?",
          `Current goal:\n${currentGoalText}\n\nNew goal:\n${nextGoal}`,
        );
        if (!confirmed) {
          ctx.ui.notify("Goal unchanged", "info");
          return;
        }
      }

      await setGoal(nextGoal, ctx.sessionManager.getSessionId());
      startActiveGoalStatus(ctx);
      ctx.ui.notify(currentGoalText ? "Goal replaced" : "Goal set", "info");
      sendGoalUserMessage(nextGoal, ctx.isIdle());
    },
  });

  pi.registerTool({
    name: "goal_complete",
    label: "Complete Goal",
    description:
      "Mark the active goal as complete. ALL evidence fields (summary, requirementsCovered, verificationsRun, taskEvidence, shortcutsConsidered) are required and each must cite concrete artifacts (file:line, exact test names, exact command output). Vague, generic, or empty values mean the goal is not yet complete — keep working instead. Calling this tool is the audit; there is no separate audit step that excuses missing evidence here.",
    parameters: GoalCompleteParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!goal) return noActiveGoal();
      const review = getVerifier(ctx);
      if (review && verifierBlock?.taskId !== undefined) {
        return rejectCompletion(verifierBlock.report, goal.tasks.find((task) => task.id === verifierBlock!.taskId));
      }
      const completingGoal = goal;

      // Exec-verified gate: completion is gated on real exit codes, not just
      // the self-narrated evidence schema. A red check blocks completion and
      // routes the failing output back so the agent keeps working.
      let verificationNote = "";
      let validationResults: ValidationEvidence[] | undefined;
      if (pi.getFlag(GOAL_NO_EXEC_GATE_FLAG) !== true) {
        const gate = await runValidationGate(ctx.cwd);
        if (gate.blocked) {
          pendingGateInjection = true;
          return {
            content: [{ type: "text", text: gate.report }],
            details: {
              goal,
              error: "Completion blocked: verification failed",
            } as GoalToolDetails,
          };
        }
        validationResults = gate.results;
        verificationNote =
          gate.commandCount > 0 ?
            ` Verified by ${gate.commandCount} command(s): all passed.`
          : " No validation commands discovered (.pi-goal.json or package.json scripts); completion not machine-verified.";
      }

      if (goal !== completingGoal || disposed) throw new Error("The goal changed before completion; retry for the current goal.");
      if (review) {
        // goal_complete also checks remaining tasks, so it cannot bypass per-task review.
        for (const task of goal.tasks.filter((candidate) => !candidate.isComplete)) {
          const rejected = await reviewCompletion(review, ctx, signal, task, params, validationResults);
          if (rejected) return rejected;
        }
        const rejected = await reviewCompletion(review, ctx, signal, undefined, params, validationResults);
        if (rejected) return rejected;
      }

      goal.isActive = false;
      goal.completedAt = now();
      goal.completionSummary = formatGoalCompletionEvidence(params);
      for (const task of goal.tasks) {
        if (!task.isComplete) {
          task.isComplete = true;
          task.completedAt = goal.completedAt;
        }
      }
      await saveGoal();
      clearGoalStatusTimer();
      setGoalStatus(ctx, formatCompletedGoalStatus(goal));
      clearGoalContinuationTimer();
      pendingGateInjection = false;

      return {
        content: [
          {
            type: "text",
            text: `Goal marked complete: ${params.summary}${verificationNote}`,
          },
        ],
        details: { goal } as GoalToolDetails,
      };
    },
  });

  pi.registerTool({
    name: "goal_task",
    label: "Goal Task",
    description:
      "Manage tasks for the active goal. Use add to create tasks, check to mark one complete, uncheck to reopen one, and list to inspect progress.",
    parameters: GoalTaskParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!goal) return noActiveGoal();

      const action = params.action;

      if (action === "list") {
        const taskList =
          goal.tasks.length ?
            goal.tasks
              .map(
                (task) =>
                  `[${task.isComplete ? "x" : " "}] #${task.id}: ${task.text}`,
              )
              .join("\n")
            : "No goal tasks";

        return {
          content: [{ type: "text", text: taskList }],
          details: { goal } as GoalToolDetails,
        };
      }

      if (action === "add") {
        if (!params.text) {
          return {
            content: [
              {
                type: "text",
                text: "Error: text is required when adding a goal task.",
              },
            ],
            details: { goal, error: "Task text required" } as GoalToolDetails,
          };
        }

        const nextTaskId =
          goal.tasks.reduce((max, task) => Math.max(max, task.id), 0) + 1;
        const task: GoalTask = {
          id: nextTaskId,
          text: params.text,
          isComplete: false,
          createdAt: now(),
          completedAt: null,
        };
        goal.tasks.push(task);
        await saveGoal();

        return {
          content: [
            { type: "text", text: `Added goal task #${task.id}: ${task.text}` },
          ],
          details: { goal } as GoalToolDetails,
        };
      }

      if (params.id === undefined) {
        return {
          content: [
            {
              type: "text",
              text: `Error: id is required to ${action} a goal task.`,
            },
          ],
          details: { goal, error: "Task id required" } as GoalToolDetails,
        };
      }

      const task = goal.tasks.find((candidate) => candidate.id === params.id);
      if (!task) {
        return {
          content: [
            { type: "text", text: `Goal task #${params.id} not found.` },
          ],
          details: {
            goal,
            error: `Task #${params.id} not found`,
          } as GoalToolDetails,
        };
      }

      if (action === "check") {
        const review = getVerifier(ctx);
        if (review) {
          if (verifierBlock?.taskId !== undefined && verifierBlock.taskId !== task.id) {
            return rejectCompletion(verifierBlock.report, goal.tasks.find((candidate) => candidate.id === verifierBlock!.taskId));
          }
          const rejected = await reviewCompletion(review, ctx, signal, task);
          if (rejected) return rejected;
        }
        task.isComplete = true;
        task.completedAt = now();
        await saveGoal();

        return {
          content: [
            {
              type: "text",
              text: `Checked goal task #${task.id}: ${task.text}`,
            },
          ],
          details: { goal } as GoalToolDetails,
        };
      }

      if (action === "uncheck") {
        task.isComplete = false;
        task.completedAt = null;
        await saveGoal();

        return {
          content: [
            {
              type: "text",
              text: `Reopened goal task #${task.id}: ${task.text}`,
            },
          ],
          details: { goal } as GoalToolDetails,
        };
      }

      const unknownAction: never = action;
      return {
        content: [
          { type: "text", text: `Unknown goal task action: ${unknownAction}` },
        ],
        details: {
          goal,
          error: `Unknown action: ${unknownAction}`,
        } as GoalToolDetails,
      };
    },
  });

  pi.registerTool({
    name: "goal_scope",
    label: "Goal Scope",
    description:
      "Declare or inspect the file scope for the active goal. Use action 'set' with allow (glob patterns the agent MAY modify) and/or deny (patterns it must NOT modify) to constrain edits; writes to out-of-scope paths are then blocked before they run. 'list' shows the current scope; 'clear' removes all constraints. Declare scope early to prevent scope creep.",
    parameters: GoalScopeParams,
    async execute(_toolCallId, params) {
      if (!goal) return noActiveGoal();

      if (params.action === "clear") {
        goalScope = { allow: [], deny: [] };
        return {
          content: [{ type: "text", text: "Goal scope cleared." }],
          details: { goal } as GoalToolDetails,
        };
      }

      if (params.action === "set") {
        goalScope = {
          allow: (params.allow ?? []).filter((p) => p.trim().length > 0),
          deny: (params.deny ?? []).filter((p) => p.trim().length > 0),
        };
      }

      const describe =
        goalScope.allow.length || goalScope.deny.length ?
          `allow: [${goalScope.allow.join(", ") || "(any)"}]\ndeny: [${goalScope.deny.join(", ") || "(none)"}]`
        : "No scope constraints set (all paths writable).";
      return {
        content: [
          {
            type: "text",
            text:
              params.action === "set" ?
                `Goal scope set.\n${describe}`
              : describe,
          },
        ],
        details: { goal } as GoalToolDetails,
      };
    },
  });

  // Hard-block writes to out-of-scope paths before they execute. Only the
  // built-in mutating tools (edit/write) are gated; reads/searches are always
  // allowed. NOTE: this does NOT intercept bash-based writes (echo >, tee,
  // sed -i, cp, …) — scope is a guardrail against accidental edit/write drift,
  // not a security sandbox. A determined agent can still mutate via bash.
  pi.on("turn_start", () => { rejectedToolBatch = false; });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "goal_task" && event.toolName !== "goal_complete") return;
    const details = event.details as { verification?: { pass: boolean } } | undefined;
    if (details?.verification?.pass === false) return { isError: true };
  });

  pi.on("tool_call", (event, ctx) => {
    // Completion tools serialize the whole batch. A rejected completion blocks
    // all later sibling calls until a fresh lead turn can act on the feedback.
    if (rejectedToolBatch && getVerifier(ctx)) {
      return { block: true, reason: verifierBlock?.report ?? "Completion verification failed. Act on its feedback before continuing." };
    }
    if (!goal?.isActive) return;
    if (!GOAL_WRITE_TOOLS.has(event.toolName)) return;
    const targetPath = (event.input as { path?: unknown }).path;
    if (typeof targetPath !== "string") return;
    const decision = evaluateScope(targetPath, ctx.cwd);
    if (decision.blocked) return { block: true, reason: decision.reason };
  });

  pi.on("context", async (event, ctx) => {
    if (!goal?.isActive) return { messages: event.messages };

    const additions = [
      {
        role: "custom" as const,
        customType: GOAL_STATE_CUSTOM_TYPE,
        content: formatGoalState(goal),
        display: false,
        details: { goal },
        timestamp: Date.now(),
      },
    ];

    if (verifierBlock && getVerifier(ctx)) {
      additions.push({
        role: "custom" as const, customType: "goal-verifier-block",
        content: `<verification_block>\n${verifierBlock.report}\n</verification_block>`,
        display: false, details: { goal }, timestamp: Date.now(),
      });
    }

    // Remind the agent of its active scope every turn so it stays in-bounds.
    if (goalScope.allow.length || goalScope.deny.length) {
      additions.push({
        role: "custom" as const,
        customType: GOAL_SCOPE_CUSTOM_TYPE,
        content:
          `<goal_scope critical="true">\n` +
          `Only modify files within this scope. Writes outside it are blocked.\n` +
          `Allowed: ${goalScope.allow.length ? goalScope.allow.join(", ") : "(any path not denied)"}\n` +
          `Denied: ${goalScope.deny.length ? goalScope.deny.join(", ") : "(none)"}\n` +
          `If a change genuinely requires touching an out-of-scope path, call goal_scope to update the scope first and note it in your completion evidence.\n` +
          `</goal_scope>`,
        display: false,
        details: { goal },
        timestamp: Date.now(),
      });
    }

    // One-shot gate injection: agent_end set the flag, this turn delivers
    // the full completion-gate prose and clears the flag. Going through the
    // context handler (custom-role message) is the only delivery path that
    // reliably reaches the LLM under all providers — `pi.sendUserMessage`
    // gets persisted to the session JSONL, but providers like cursor-agent
    // do not pass synthetic user-message bodies into the model's
    // user_query envelope, so a sendUserMessage-only delivery is silently
    // invisible to the model in that environment.
    if (pendingGateInjection) {
      pendingGateInjection = false;
      additions.push({
        role: "custom" as const,
        customType: GOAL_COMPLETION_GATE_CUSTOM_TYPE,
        content: formatGoalCompletionGateMessage(goal),
        display: false,
        details: { goal },
        timestamp: Date.now(),
      });
    }

    return { messages: [...event.messages, ...additions] };
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (goal?.isActive) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${formatGoalMissionPrompt()}`,
      } as BeforeAgentStartEventResult;
    }

    return {
      systemPrompt: event.systemPrompt,
    } as BeforeAgentStartEventResult;
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!goal?.isActive) return;

    clearGoalContinuationTimer();
    goalContinuationTimer = setTimeout(async () => {
      goalContinuationTimer = null;
      const activeGoal = goal;
      if (!activeGoal?.isActive) return;

      // Gate-pass circuit breaker. Count this pass; reset happens on genuine
      // code progress (see the tool_execution_end handler). Escalate the
      // thinking level once when the agent starts looping, and hard-stop the
      // gate entirely after the configured maximum to prevent an infinite,
      // token-burning loop (the prerequisite that makes the exec gate safe).
      gatePassCount += 1;
      const maxPasses = getMaxGatePasses();

      if (gatePassCount === GOAL_GATE_ESCALATE_AT && gatePassCount < maxPasses) {
        try {
          pi.setThinkingLevel("high");
        } catch {
          // Model may not support thinking; escalation is best-effort.
        }
      }

      if (gatePassCount >= maxPasses) {
        activeGoal.isActive = false;
        activeGoal.completedAt = now();
        activeGoal.completionSummary =
          `Goal gate hard-stopped after ${gatePassCount} consecutive passes ` +
          `without code progress: the agent neither completed the goal nor ` +
          `made edits between gate passes. Refine the goal or raise ` +
          `--${GOAL_MAX_GATE_PASSES_FLAG}.`;
        // Await persistence before aborting: ctx.abort() may tear down the
        // run, and an unawaited save could be lost, leaving a stale active
        // goal that wrongly resumes on the next session_start.
        await saveGoal();
        clearGoalStatusTimer();
        setGoalStatus(
          ctx,
          colorizeGoalStatus(
            `Goal gate stopped after ${gatePassCount} passes without progress`,
          ),
        );
        ctx.ui.notify(
          `Goal gate stopped after ${gatePassCount} passes without progress. ` +
            `Refine the goal or raise --${GOAL_MAX_GATE_PASSES_FLAG}.`,
          "warning",
        );
        pendingGateInjection = false;
        try {
          ctx.abort();
        } catch {
          // No active operation to abort; the goal is already inactive.
        }
        return;
      }

      // Two-channel delivery, separated for robustness:
      //
      //   1. The gate *body* is delivered via the `context` handler as a
      //      custom-role message. Setting pendingGateInjection=true here
      //      arms the next context call (which fires before the upcoming
      //      LLM call). This is the only channel that reliably reaches
      //      the model under cursor-agent: synthetic user-message bodies
      //      are stripped from cursor-agent's user_query envelope, but
      //      custom-role context messages flow through unmodified (the
      //      goal_state injection uses the same channel and is observably
      //      delivered every turn).
      //
      //   2. A short, neutral trigger text is sent via sendUserMessage so
      //      the agent actually *takes another turn*. The body of this
      //      message is not the gate — it's a placeholder whose only job
      //      is to leave the idle state. `deliverAs: "followUp"` makes it
      //      robust against the brief window where pi.isStreaming may
      //      still be true (auto-compaction / auto-retry / user steer
      //      between agent_end and this deferred timer); without a
      //      delivery mode, prompt() throws "Agent is already
      //      processing..." inside an async fn and bindCore's
      //      .catch(emitError) wrapper silently swallows it.
      //
      // Together: arm the body, then trigger the turn. The synchronous
      // try/catch only intercepts assertActive() throws on a stale
      // runtime; async sendUserMessage failures are not catchable here
      // by design (see bindCore in pi-coding-agent's loader.js).
      pendingGateInjection = true;
      try {
        pi.sendUserMessage(GOAL_GATE_TRIGGER_TEXT, {
          deliverAs: "followUp",
        });
      } catch {
        // Stale runtime — context handler may not run, so unset the flag
        // so we don't inject a stale gate against a future session.
        pendingGateInjection = false;
      }
    }, 0);
    goalContinuationTimer.unref?.();
  });

  // Genuine code progress resets the stuck-counter, so the circuit breaker
  // only trips on turns that loop without editing (text-only stops or repeated
  // goal_complete retries that never fix the failing verification).
  pi.on("tool_execution_end", (event) => {
    if (!goal?.isActive) return;
    if (GOAL_PROGRESS_TOOLS.has(event.toolName)) {
      gatePassCount = 0;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    disposed = true;
    clearGoalContinuationTimer();
    clearGoalStatusTimer();
    setGoalStatus(ctx, undefined);
    await goalManager.close();
  });
}
