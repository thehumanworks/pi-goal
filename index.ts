#!/usr/bin/env -S bun
import type {
  ExtensionAPI,
  ExtensionContext,
  BeforeAgentStartEventResult,
} from "@mariozechner/pi-coding-agent";
import { StringEnum, Type } from "@mariozechner/pi-ai";
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

const GOALS_DIR = path.join(process.env.HOME!, ".pi", "agent", "goals");
const GOAL_STATUS_UPDATE_INTERVAL_MS = 1000;
const GOAL_STATE_CUSTOM_TYPE = "goal-state";
const GOAL_COMPLETION_GATE_CUSTOM_TYPE = "goal-completion-gate";
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
    goal = nextGoal;
    goalSessionId = sessionId;
  };

  // Rehydrate a previously persisted goal into the in-memory cache without
  // mutating SQLite (used during session_start / reload / resume).
  const adoptPersistedGoal = (persistedGoal: GoalJson, sessionId: string) => {
    clearGoalContinuationTimer();
    pendingGateInjection = false;
    goal = persistedGoal;
    goalSessionId = sessionId;
  };

  const sendGoalUserMessage = (goalText: string, isIdle: boolean) => {
    if (isIdle) {
      pi.sendUserMessage(goalText);
      return;
    }

    pi.sendUserMessage(goalText, { deliverAs: "steer" });
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
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!goal) return noActiveGoal();

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
          { type: "text", text: `Goal marked complete: ${params.summary}` },
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
    async execute(_toolCallId, params) {
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

  pi.on("context", async (event) => {
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

  pi.on("agent_end", (_event, _ctx) => {
    if (!goal?.isActive) return;

    clearGoalContinuationTimer();
    goalContinuationTimer = setTimeout(() => {
      goalContinuationTimer = null;
      const activeGoal = goal;
      if (!activeGoal?.isActive) return;

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

  pi.on("session_shutdown", async (_event, ctx) => {
    clearGoalContinuationTimer();
    clearGoalStatusTimer();
    setGoalStatus(ctx, undefined);
    goalManager.close();
  });
}
