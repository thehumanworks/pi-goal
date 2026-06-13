import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createGoalManager,
  GOALS_DB_FILENAME,
  type GoalJson,
} from "./goalManager.ts";

type RegisteredCommand = {
  handler: (args: string, ctx: any) => Promise<void> | void;
};

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal,
    onUpdate: () => void,
    ctx: any,
  ) => Promise<any> | any;
};

type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
};

type TestHarness = {
  home: string;
  commands: Map<string, RegisteredCommand>;
  handlers: Map<string, Function>;
  tools: Map<string, RegisteredTool>;
  sentUserMessages: Array<{ text: string; options?: unknown }>;
  execCalls: Array<{ command: string; args: string[]; options?: unknown }>;
  thinkingLevels: string[];
  abortCount: number;
  ctx: any;
  setFlag(name: string, value: unknown): void;
  executeTool(name: string, params: Record<string, unknown>): Promise<any>;
};

const originalHome = process.env.HOME;
const homesToRemove: string[] = [];
const cleanupCallbacks: Array<() => void | Promise<void>> = [];

const goalsDir = (home: string) => path.join(home, ".pi", "agent", "goals");
const goalsDbPath = (home: string) => path.join(goalsDir(home), GOALS_DB_FILENAME);
const waitForDeferredCallbacks = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));

const createHarness = async (
  existingHome?: string,
  opts?: {
    isIdle?: () => boolean;
    sendUserMessage?: (text: string, options?: unknown) => void;
    exec?: (
      command: string,
      args: string[],
      options?: unknown,
    ) => ExecResult | Promise<ExecResult>;
    cwd?: string;
  },
): Promise<TestHarness> => {
  const home =
    existingHome ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-extension-"));
  if (!existingHome) homesToRemove.push(home);
  process.env.HOME = home;

  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, Function>();
  const tools = new Map<string, RegisteredTool>();
  const flags = new Map<string, unknown>();
  const sentUserMessages: Array<{ text: string; options?: unknown }> = [];
  const execCalls: Array<{
    command: string;
    args: string[];
    options?: unknown;
  }> = [];
  const thinkingLevels: string[] = [];

  const pi = {
    registerFlag(name: string) {
      flags.set(name, undefined);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    registerCommand(name: string, command: RegisteredCommand) {
      commands.set(name, command);
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    on(event: string, handler: Function) {
      handlers.set(event, handler);
    },
    sendUserMessage(text: string, options?: unknown) {
      if (opts?.sendUserMessage) {
        opts.sendUserMessage(text, options);
      }
      sentUserMessages.push({ text, options });
    },
    async exec(command: string, args: string[], options?: unknown) {
      execCalls.push({ command, args, options });
      if (opts?.exec) return await opts.exec(command, args, options);
      return { stdout: "", stderr: "", code: 0, killed: false };
    },
    setThinkingLevel(level: string) {
      thinkingLevels.push(level);
    },
  } as unknown as ExtensionAPI;

  const { default: registerGoalExtension } = await import(
    `./index.ts?test=${Date.now()}-${Math.random()}`
  );
  registerGoalExtension(pi);

  let abortCount = 0;
  const ctx = {
    hasUI: true,
    cwd: opts?.cwd ?? home,
    isIdle: opts?.isIdle ?? (() => true),
    abort: () => {
      abortCount += 1;
    },
    sessionManager: {
      getSessionId: () => "test-session",
    },
    ui: {
      notify() {},
      setStatus() {},
      setWorkingMessage() {},
      confirm: async () => true,
    },
  };

  const setFlag = (name: string, value: unknown) => {
    flags.set(name, value);
  };

  const executeTool = async (
    name: string,
    params: Record<string, unknown>,
  ) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`Tool not registered: ${name}`);
    return await tool.execute(
      "test-tool-call",
      params,
      new AbortController().signal,
      () => {},
      ctx,
    );
  };

  cleanupCallbacks.push(async () => {
    await handlers.get("session_shutdown")?.({}, ctx);
  });

  return {
    home,
    commands,
    handlers,
    tools,
    sentUserMessages,
    execCalls,
    thinkingLevels,
    get abortCount() {
      return abortCount;
    },
    ctx,
    setFlag,
    executeTool,
  };
};

afterEach(async () => {
  process.env.HOME = originalHome;
  for (const cleanup of cleanupCallbacks.splice(0)) {
    await cleanup();
  }
  for (const home of homesToRemove.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

const readSavedGoal = async (home: string, sessionId = "test-session") => {
  const manager = createGoalManager(goalsDir(home));
  try {
    return await manager.loadGoal(sessionId);
  } finally {
    await manager.close();
  }
};

const expectSavedGoal = async (home: string): Promise<GoalJson> => {
  const goal = await readSavedGoal(home);
  expect(goal).not.toBeNull();
  return goal!;
};

// Poll the persisted goal until a predicate holds. Used where persistence is
// fire-and-forget (e.g. the circuit breaker's hard-stop saves without awaiting).
const waitForSavedGoal = async (
  home: string,
  predicate: (goal: GoalJson) => boolean,
  attempts = 50,
): Promise<GoalJson> => {
  for (let i = 0; i < attempts; i++) {
    const goal = await readSavedGoal(home);
    if (goal && predicate(goal)) return goal;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitForSavedGoal: predicate not satisfied in time");
};

describe("goalManager SQLite persistence", () => {
  test("stores goals in a SQLite DB in the existing goals directory", async () => {
    const harness = await createHarness();

    await harness.commands.get("goal")!.handler("Persist this goal", harness.ctx);

    expect(fs.existsSync(goalsDbPath(harness.home))).toBe(true);
    expect((await expectSavedGoal(harness.home)).goal).toBe("Persist this goal");
  });

  test("round-trips goals and ordered tasks through a fresh manager", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-manager-"));
    homesToRemove.push(home);
    const manager = createGoalManager(goalsDir(home), { now: () => "1000" });

    const goal = await manager.createGoal("session-a", "Round-trip goal");
    goal.tasks.push(
      {
        id: 2,
        text: "second task",
        isComplete: true,
        createdAt: "1002",
        completedAt: "1003",
      },
      {
        id: 1,
        text: "first task",
        isComplete: false,
        createdAt: "1001",
        completedAt: null,
      },
    );
    goal.lastUpdatedAt = "1004";
    goal.totalDuration = 4;
    await manager.saveGoal("session-a", goal);
    await manager.close();

    const freshManager = createGoalManager(goalsDir(home));
    try {
      expect(await freshManager.loadGoal("session-a")).toEqual({
        goal: "Round-trip goal",
        createdAt: "1000",
        lastUpdatedAt: "1004",
        completedAt: null,
        completionSummary: null,
        totalDuration: 4,
        isActive: true,
        tasks: [
          {
            id: 1,
            text: "first task",
            isComplete: false,
            createdAt: "1001",
            completedAt: null,
          },
          {
            id: 2,
            text: "second task",
            isComplete: true,
            createdAt: "1002",
            completedAt: "1003",
          },
        ],
      });
    } finally {
      await freshManager.close();
    }
  });
});

describe("/goal slash command parsing", () => {
  test("treats all unquoted text after /goal as one goal", async () => {
    const harness = await createHarness();

    await harness.commands
      .get("goal")!
      .handler(
        "When defining a goal via the slash command, all remaining text is the single goal",
        harness.ctx,
      );

    expect((await expectSavedGoal(harness.home)).goal).toBe(
      "When defining a goal via the slash command, all remaining text is the single goal",
    );
    expect(harness.sentUserMessages).toEqual([
      {
        text: "When defining a goal via the slash command, all remaining text is the single goal",
        options: { deliverAs: "followUp" },
      },
    ]);
  });

  test("does not require quotes, but preserves compatibility with quoted goals", async () => {
    const harness = await createHarness();

    await harness.commands
      .get("goal")!
      .handler(
        '"When defining a goal, quoted text is still treated as one goal"',
        harness.ctx,
      );

    expect((await expectSavedGoal(harness.home)).goal).toBe(
      "When defining a goal, quoted text is still treated as one goal",
    );
  });

  test("also accepts a full slash invocation and uses all text after the command", async () => {
    const harness = await createHarness();

    await harness.commands
      .get("goal")!
      .handler(
        "/goal Ship the feature without wrapping the goal in quotes",
        harness.ctx,
      );

    expect((await expectSavedGoal(harness.home)).goal).toBe(
      "Ship the feature without wrapping the goal in quotes",
    );
  });
});

describe("goal lifecycle integration", () => {
  test("persists goals supplied by the session_start flag", async () => {
    const harness = await createHarness();
    harness.setFlag("goal", "Reach the flagged goal");

    await harness.handlers.get("session_start")!({}, harness.ctx);

    expect((await expectSavedGoal(harness.home)).goal).toBe("Reach the flagged goal");
    // Delivered with an explicit deliverAs (never a bare plain send) so it can
    // never async-reject with "Agent is already processing" in headless mode.
    expect(harness.sentUserMessages).toEqual([
      { text: "Reach the flagged goal", options: { deliverAs: "followUp" } },
    ]);
  });

  test("replacing a goal keeps confirmation behavior and clears old tasks", async () => {
    const harness = await createHarness();
    await harness.commands.get("goal")!.handler("Original goal", harness.ctx);
    await harness.executeTool("goal_task", { action: "add", text: "Old task" });

    await harness.commands.get("goal")!.handler("Replacement goal", harness.ctx);

    const persistedGoal = await expectSavedGoal(harness.home);
    expect(persistedGoal.goal).toBe("Replacement goal");
    expect(persistedGoal.tasks).toEqual([]);
    expect(harness.sentUserMessages.map((message) => message.text)).toEqual([
      "Original goal",
      "Replacement goal",
    ]);
  });

  test("after agent_end, sends a turn-trigger via sendUserMessage and arms the next context call to inject the gate", async () => {
    const harness = await createHarness();
    await harness.commands.get("goal")!.handler("Keep going", harness.ctx);
    await harness.executeTool("goal_task", { action: "add", text: "Verify work" });

    harness.handlers.get("agent_end")!({ messages: [] }, harness.ctx);

    expect(harness.sentUserMessages.map((message) => message.text)).toEqual([
      "Keep going",
    ]);

    await waitForDeferredCallbacks();

    // The deferred sendUserMessage carries only the brief trigger text,
    // not the gate prose. The trigger's only job is to leave the idle
    // state so the next LLM turn fires; the actual gate body is delivered
    // via the `context` handler (the only channel that reliably reaches
    // the LLM under cursor-agent, which strips synthetic user-message
    // bodies from the user_query envelope).
    expect(harness.sentUserMessages).toHaveLength(2);
    const triggerDelivery = harness.sentUserMessages[1]!;
    expect(triggerDelivery.text).toBe(
      "Reached end of agent run with active goal — running completion gate.",
    );
    expect(triggerDelivery.text).not.toContain("GOAL COMPLETION GATE");
    // Robust delivery: the trigger is queued as a follow-up so it survives
    // the brief window where pi may still be streaming/compacting/retrying
    // (or a user-typed message re-entered streaming) right after agent_end.
    // Without a delivery mode, pi-coding-agent's prompt() throws "Agent is
    // already processing" and the runtime silently swallows that rejection.
    expect(triggerDelivery.options).toEqual({ deliverAs: "followUp" });

    // The next context call (the one that fires before the upcoming LLM
    // turn that the trigger above caused) must include the full gate
    // prose as a custom-role message in addition to the usual goal_state.
    const armed = await harness.handlers.get("context")!(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      harness.ctx,
    );
    expect(armed.messages).toHaveLength(3);
    const goalState = armed.messages[1];
    expect(goalState.role).toBe("custom");
    expect(goalState.customType).toBe("goal-state");
    const gate = armed.messages[2];
    expect(gate.role).toBe("custom");
    expect(gate.customType).toBe("goal-completion-gate");
    expect(gate.display).toBe(false);
    expect(gate.content).toContain("GOAL COMPLETION GATE");
    expect(gate.content).toContain("Current goal: Keep going");
    expect(gate.content).toContain("- [ ] #1: Verify work");
    expect(gate.content).toContain("goal_complete");
    // Slim gate: the audit lives in the goal_complete tool's parameter
    // descriptions, not in the gate prose. The gate must not duplicate
    // a separate procedural checklist (which would inevitably drift from
    // the tool schema) — it just routes the agent back to one of two
    // structured choices.
    expect(gate.content).not.toContain("Completion audit checklist");
    expect(gate.content).not.toContain("A. Scope and requirements");
    expect(gate.content).not.toContain("Did you run linter and formatter");
    expect(gate.content).toContain("Do exactly one of");
    expect(gate.content).toContain("evidence field");

    // The gate is one-shot: subsequent context calls before the next
    // agent_end must NOT re-inject the gate (otherwise every LLM call
    // mid-turn would balloon with the full audit checklist).
    const followup = await harness.handlers.get("context")!(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      harness.ctx,
    );
    expect(followup.messages).toHaveLength(2);
    expect(followup.messages[1].customType).toBe("goal-state");
  });

  test("re-arms the gate on every agent_end so a multi-turn back-and-forth keeps prompting completion audits", async () => {
    const harness = await createHarness();
    await harness.commands.get("goal")!.handler("Repeat audits", harness.ctx);

    // First agent_end → gate is delivered on the next context call.
    harness.handlers.get("agent_end")!({ messages: [] }, harness.ctx);
    await waitForDeferredCallbacks();
    let result = await harness.handlers.get("context")!(
      { messages: [] },
      harness.ctx,
    );
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].customType).toBe("goal-completion-gate");

    // Second agent_end (e.g., LLM ended again without calling goal_complete)
    // must re-arm the flag so the next context call also injects the gate.
    harness.handlers.get("agent_end")!({ messages: [] }, harness.ctx);
    await waitForDeferredCallbacks();
    result = await harness.handlers.get("context")!(
      { messages: [] },
      harness.ctx,
    );
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1].customType).toBe("goal-completion-gate");
  });

  test("queues the trigger as followUp even when a steered user message lands between agent_end and the deferred timer", async () => {
    const harness = await createHarness();
    await harness.commands.get("goal")!.handler("Stay robust", harness.ctx);

    // agent_end fires while the goal is active, scheduling the trigger.
    harness.handlers.get("agent_end")!({ messages: [] }, harness.ctx);

    // Before the deferred setTimeout(0) fires, a user-typed steering message
    // arrives. In real pi this re-enters streaming, which is exactly the
    // window where a sendUserMessage without `deliverAs` would silently fail
    // because pi-coding-agent's prompt() throws and the runtime wrapper
    // swallows the async rejection via emitError.
    harness.sentUserMessages.push({
      text: "user typed something here",
      options: { deliverAs: "steer" },
    });

    await waitForDeferredCallbacks();

    // The trigger must still be delivered as followUp so pi queues it
    // rather than rejecting it, and the gate body must still arrive on
    // the next context call.
    expect(harness.sentUserMessages).toHaveLength(3);
    const triggerDelivery = harness.sentUserMessages[2]!;
    expect(triggerDelivery.text).toBe(
      "Reached end of agent run with active goal — running completion gate.",
    );
    expect(triggerDelivery.options).toEqual({ deliverAs: "followUp" });

    const armed = await harness.handlers.get("context")!(
      { messages: [] },
      harness.ctx,
    );
    expect(armed.messages).toHaveLength(2);
    expect(armed.messages[1].customType).toBe("goal-completion-gate");
    expect(armed.messages[1].content).toContain("GOAL COMPLETION GATE");
  });

  test("clears the pending gate when the goal is completed before the next LLM call", async () => {
    const harness = await createHarness();
    await harness.commands.get("goal")!.handler("Race condition", harness.ctx);

    harness.handlers.get("agent_end")!({ messages: [] }, harness.ctx);
    await waitForDeferredCallbacks();

    // Goal completes after the trigger fired but before the context handler
    // runs. The next context call must NOT inject a stale gate.
    await harness.executeTool("goal_complete", {
      summary: "Done before the gate could inject.",
    });

    const result = await harness.handlers.get("context")!(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      harness.ctx,
    );

    // No goal-state, no gate — the goal is no longer active.
    expect(result.messages).toHaveLength(1);
  });

  test("does not send a deferred continuation reminder after the goal is completed", async () => {
    const harness = await createHarness();
    await harness.commands.get("goal")!.handler("Finish once", harness.ctx);

    harness.handlers.get("agent_end")!({ messages: [] }, harness.ctx);
    await harness.executeTool("goal_complete", {
      summary: "Done before the deferred reminder ran.",
    });
    await waitForDeferredCallbacks();

    expect(harness.sentUserMessages.map((message) => message.text)).toEqual([
      "Finish once",
    ]);
  });
});

describe("goal and task tracking tools", () => {
  test("preserves add, list, check, and uncheck task behavior while persisting to SQLite", async () => {
    const harness = await createHarness();
    await harness.commands.get("goal")!.handler("Track goal tasks", harness.ctx);

    const emptyList = await harness.executeTool("goal_task", { action: "list" });
    expect(emptyList.content[0].text).toBe("No goal tasks");

    const addFirst = await harness.executeTool("goal_task", {
      action: "add",
      text: "Write implementation",
    });
    expect(addFirst.content[0].text).toBe(
      "Added goal task #1: Write implementation",
    );

    const addSecond = await harness.executeTool("goal_task", {
      action: "add",
      text: "Run tests",
    });
    expect(addSecond.content[0].text).toBe("Added goal task #2: Run tests");

    const list = await harness.executeTool("goal_task", { action: "list" });
    expect(list.content[0].text).toBe(
      "[ ] #1: Write implementation\n[ ] #2: Run tests",
    );

    await harness.executeTool("goal_task", { action: "check", id: 1 });
    let persistedGoal = await expectSavedGoal(harness.home);
    expect(persistedGoal.tasks).toHaveLength(2);
    expect(persistedGoal.tasks[0]).toMatchObject({
      id: 1,
      text: "Write implementation",
      isComplete: true,
    });
    expect(persistedGoal.tasks[0]!.completedAt).not.toBeNull();
    expect(persistedGoal.tasks[1]).toMatchObject({
      id: 2,
      text: "Run tests",
      isComplete: false,
      completedAt: null,
    });

    const uncheck = await harness.executeTool("goal_task", {
      action: "uncheck",
      id: 1,
    });
    expect(uncheck.content[0].text).toBe(
      "Reopened goal task #1: Write implementation",
    );
    persistedGoal = await expectSavedGoal(harness.home);
    expect(persistedGoal.tasks[0]).toMatchObject({
      id: 1,
      isComplete: false,
      completedAt: null,
    });
  });

  test("preserves validation errors for missing task text, missing id, and unknown ids", async () => {
    const harness = await createHarness();
    await harness.commands.get("goal")!.handler("Validate task errors", harness.ctx);

    const missingText = await harness.executeTool("goal_task", { action: "add" });
    expect(missingText.content[0].text).toBe(
      "Error: text is required when adding a goal task.",
    );
    expect(missingText.details.error).toBe("Task text required");

    const missingId = await harness.executeTool("goal_task", { action: "check" });
    expect(missingId.content[0].text).toBe(
      "Error: id is required to check a goal task.",
    );
    expect(missingId.details.error).toBe("Task id required");

    const notFound = await harness.executeTool("goal_task", {
      action: "uncheck",
      id: 99,
    });
    expect(notFound.content[0].text).toBe("Goal task #99 not found.");
    expect(notFound.details.error).toBe("Task #99 not found");
  });

  test("completes an active goal, serialises structured evidence into completionSummary, and completes remaining tasks in SQLite", async () => {
    const harness = await createHarness();
    await harness.commands.get("goal")!.handler("Complete the goal", harness.ctx);
    await harness.executeTool("goal_task", { action: "add", text: "Already done" });
    await harness.executeTool("goal_task", { action: "check", id: 1 });
    await harness.executeTool("goal_task", { action: "add", text: "Finish me too" });

    const complete = await harness.executeTool("goal_complete", {
      summary: "All work is done and verified.",
      requirementsCovered:
        "- User asked X → satisfied at index.ts:42-58 and locked by test 'does X' (index.test.ts:120).",
      verificationsRun: "bun test → 22 pass, 0 fail, 92 expect(); tsc --noEmit → 0 errors.",
      taskEvidence:
        "#1 'Already done' → implementation at index.ts:42; #2 'Finish me too' → implementation at index.ts:80, regression test index.test.ts:120.",
      shortcutsConsidered:
        "Considered skipping the regression test for #2; rejected and added it at index.test.ts:120.",
    });

    // The tool result string keeps the brief headline summary so the chat
    // surface stays readable; the structured evidence lives in the
    // persisted completionSummary blob.
    expect(complete.content[0].text).toContain(
      "Goal marked complete: All work is done and verified.",
    );
    // The sandbox has no package.json / .pi-goal.json, so the exec gate finds
    // no verification commands and transparently flags completion as not
    // machine-verified (graceful degradation) rather than blocking.
    expect(complete.content[0].text).toContain("No validation commands discovered");
    const persistedGoal = await expectSavedGoal(harness.home);
    expect(persistedGoal.isActive).toBe(false);
    expect(persistedGoal.completedAt).not.toBeNull();
    const persistedSummary = persistedGoal.completionSummary!;
    expect(persistedSummary).toContain("Summary: All work is done and verified.");
    expect(persistedSummary).toContain("Requirements covered:");
    expect(persistedSummary).toContain("locked by test 'does X'");
    expect(persistedSummary).toContain("Verifications run:");
    expect(persistedSummary).toContain("bun test → 22 pass, 0 fail");
    expect(persistedSummary).toContain("Task evidence:");
    expect(persistedSummary).toContain("#1 'Already done'");
    expect(persistedSummary).toContain("Shortcuts considered:");
    expect(persistedSummary).toContain("rejected and added it at index.test.ts:120");
    expect(persistedGoal.tasks.every((task) => task.isComplete)).toBe(true);
    expect(persistedGoal.tasks.every((task) => task.completedAt !== null)).toBe(
      true,
    );
  });

  test("reports no active goal through tools before a goal is set", async () => {
    const harness = await createHarness();

    const result = await harness.executeTool("goal_task", { action: "list" });

    expect(result.content[0].text).toBe(
      "No active goal is configured for this session.",
    );
    expect(result.details).toEqual({ goal: null, error: "No active goal" });
  });

  test("goal_complete tool schema is the audit: all five evidence fields required, descriptions demand concrete artifacts and forbid shortcuts", async () => {
    const harness = await createHarness();
    type FieldShape = { description: string };
    const tool = harness.tools.get("goal_complete") as unknown as {
      description: string;
      parameters: {
        properties: {
          summary: FieldShape;
          requirementsCovered: FieldShape;
          verificationsRun: FieldShape;
          taskEvidence: FieldShape;
          shortcutsConsidered: FieldShape;
        };
        required?: string[];
      };
    };

    // The tool description routes the agent to fill every field with
    // concrete evidence and explicitly says the schema IS the audit (so
    // there is no separate procedural checklist to skim through).
    expect(tool.description).toContain("ALL evidence fields");
    expect(tool.description).toContain("required");
    expect(tool.description).toContain("concrete artifacts");
    expect(tool.description).toContain("Vague, generic, or empty values");
    expect(tool.description).toContain("Calling this tool is the audit");

    // Every evidence field is present and required by the schema. We do
    // not maintain a separate response-text-matching layer; presence is
    // enforced by the LLM API via the schema, and quality is enforced by
    // the per-field descriptions below.
    const expectedFields = [
      "summary",
      "requirementsCovered",
      "verificationsRun",
      "taskEvidence",
      "shortcutsConsidered",
    ];
    expect(Object.keys(tool.parameters.properties).sort()).toEqual(
      [...expectedFields].sort(),
    );
    expect((tool.parameters.required ?? []).sort()).toEqual(
      [...expectedFields].sort(),
    );

    // Each field's description must demand concrete artifacts (file:line,
    // exact test names, exact command output) so the LLM cannot satisfy
    // the schema with vague answers.
    const props = tool.parameters.properties;
    expect(props.requirementsCovered.description).toContain("file path");
    expect(props.requirementsCovered.description).toMatch(/vague/i);
    expect(props.verificationsRun.description).toMatch(/exact commands/i);
    expect(props.verificationsRun.description).toContain("bun test");
    expect(props.taskEvidence.description).toMatch(/concrete evidence/i);
    expect(props.shortcutsConsidered.description).toMatch(
      /forcing function|hand-wavy|shortcut/i,
    );
    expect(props.shortcutsConsidered.description).toMatch(/keep working/i);
  });
});

describe("goal prompt integration", () => {
  test("injects a stable goal mission into the system prompt that points at the goal_complete tool's schema as the audit (no inlined procedural checklist)", async () => {
    const harness = await createHarness();
    await harness.commands.get("goal")!.handler("Prompt goal", harness.ctx);

    const result = await harness.handlers.get("before_agent_start")!(
      { systemPrompt: "base prompt\n" },
      harness.ctx,
    );

    expect(result.systemPrompt).toContain("base prompt");
    expect(result.systemPrompt).toContain("<goal critical=\"true\">");
    expect(result.systemPrompt).toContain("Fresh goal status is injected in <goal_state>");
    // The mission routes the agent to the tool, not to a free-text checklist.
    expect(result.systemPrompt).toContain("goal_complete");
    expect(result.systemPrompt).toContain("evidence fields populated");
    expect(result.systemPrompt).toContain("concrete artifacts");
    // Procedural / response-text-matching artifacts must not be inlined.
    expect(result.systemPrompt).not.toContain("Completion audit checklist");
    expect(result.systemPrompt).not.toContain("A. Scope and requirements");
    expect(result.systemPrompt).not.toContain("Did you run linter and formatter");
  });

  test("injects lightweight current goal state into context before each LLM call", async () => {
    const harness = await createHarness();
    await harness.commands.get("goal")!.handler("Prompt goal", harness.ctx);
    await harness.executeTool("goal_task", { action: "add", text: "Prompt task" });
    await harness.executeTool("goal_task", { action: "check", id: 1 });
    await harness.executeTool("goal_task", { action: "add", text: "Next task" });

    const result = await harness.handlers.get("context")!(
      { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      harness.ctx,
    );

    expect(result.messages).toHaveLength(2);
    const goalState = result.messages[1];
    expect(goalState.role).toBe("custom");
    expect(goalState.customType).toBe("goal-state");
    expect(goalState.display).toBe(false);
    expect(goalState.content).toContain("<goal_state critical=\"true\">");
    expect(goalState.content).toContain("Current goal: Prompt goal");
    expect(goalState.content).toContain("- [x] #1: Prompt task");
    expect(goalState.content).toContain("- [ ] #2: Next task");
    expect(goalState.content).toContain("Next task/action: #2: Next task");
    // The instruction line must point at the structured tool schema as the
    // audit, not duplicate a procedural checklist.
    expect(goalState.content).toContain("goal_complete");
    expect(goalState.content).toContain("required evidence field");
    expect(goalState.content).toContain("concrete artifacts");
    expect(goalState.content).not.toContain("Completion audit checklist");
    expect(goalState.content).not.toContain("Did you run linter and formatter");
  });
});

describe("goal restoration on session_start", () => {
  test("rehydrates an active persisted goal (and its tasks) on session_start so /reload, restart, or resume keep working towards the same goal", async () => {
    const first = await createHarness();
    await first.commands.get("goal")!.handler("Resume me", first.ctx);
    await first.executeTool("goal_task", { action: "add", text: "Resume task" });
    // Close the SQLite handle so a fresh instance can reopen it.
    await first.handlers.get("session_shutdown")!({}, first.ctx);

    const second = await createHarness(first.home);
    await second.handlers.get("session_start")!(
      { type: "session_start", reason: "resume" },
      second.ctx,
    );

    // The persisted task is visible to tools, proving the goal was rehydrated.
    const list = await second.executeTool("goal_task", { action: "list" });
    expect(list.content[0].text).toBe("[ ] #1: Resume task");

    // The mission prompt is injected because the rehydrated goal is active.
    const promptResult = await second.handlers.get("before_agent_start")!(
      { systemPrompt: "base" },
      second.ctx,
    );
    expect(promptResult.systemPrompt).toContain("<goal critical=\"true\">");

    // No automatic re-send of the goal text on restore.
    expect(second.sentUserMessages).toEqual([]);
  });

  test("rehydrates a completed persisted goal as inactive (no auto-restart, no mission prompt injection)", async () => {
    const first = await createHarness();
    await first.commands.get("goal")!.handler("Already done", first.ctx);
    await first.executeTool("goal_complete", { summary: "All set." });
    await first.handlers.get("session_shutdown")!({}, first.ctx);

    const second = await createHarness(first.home);
    await second.handlers.get("session_start")!(
      { type: "session_start", reason: "resume" },
      second.ctx,
    );

    // No mission prompt for completed goals.
    const promptResult = await second.handlers.get("before_agent_start")!(
      { systemPrompt: "base" },
      second.ctx,
    );
    expect(promptResult.systemPrompt).toBe("base");

    // No deferred completion-gate fires for completed goals.
    second.handlers.get("agent_end")!({ messages: [] }, second.ctx);
    await waitForDeferredCallbacks();
    expect(second.sentUserMessages).toEqual([]);
  });

  test("an explicit --goal flag overrides any persisted goal and resets its tasks", async () => {
    const first = await createHarness();
    await first.commands.get("goal")!.handler("Old goal", first.ctx);
    await first.executeTool("goal_task", { action: "add", text: "Old task" });
    await first.handlers.get("session_shutdown")!({}, first.ctx);

    const second = await createHarness(first.home);
    second.setFlag("goal", "Flag goal wins");
    await second.handlers.get("session_start")!(
      { type: "session_start", reason: "resume" },
      second.ctx,
    );

    const persistedGoal = await readSavedGoal(second.home);
    expect(persistedGoal!.goal).toBe("Flag goal wins");
    expect(persistedGoal!.tasks).toEqual([]);
    expect(second.sentUserMessages.map((message) => message.text)).toEqual([
      "Flag goal wins",
    ]);
  });
});

describe("goal continuation timer cleanup", () => {
  test("replacing the active goal cancels the pending completion-gate prompt scheduled by the previous agent_end", async () => {
    const harness = await createHarness();
    await harness.commands.get("goal")!.handler("Original goal", harness.ctx);

    // Schedule a deferred completion-gate prompt.
    harness.handlers.get("agent_end")!({ messages: [] }, harness.ctx);

    // Replace the goal before the timer fires; the pending gate prompt should
    // be cancelled rather than firing against the freshly-set replacement.
    await harness.commands.get("goal")!.handler("Replacement goal", harness.ctx);

    await waitForDeferredCallbacks();

    expect(harness.sentUserMessages.map((message) => message.text)).toEqual([
      "Original goal",
      "Replacement goal",
    ]);
  });
});

describe("headless/print-mode goal injection robustness", () => {
  test("session_start delivers the flagged goal via a queued follow-up when a plain send throws 'Agent is already processing' (headless mode)", async () => {
    // In `pi -p` print mode, ctx.isIdle() can report true at session_start
    // while a prompt is already being processed, so a plain sendUserMessage
    // (no deliverAs) throws "Agent is already processing" and kills the run
    // with zero turns. The extension must recover by re-delivering as a
    // queued follow-up instead of letting the throw escape session_start.
    const harness = await createHarness(undefined, {
      isIdle: () => true,
      sendUserMessage: (_text, options) => {
        const deliverAs = (options as { deliverAs?: string } | undefined)
          ?.deliverAs;
        if (!deliverAs) {
          throw new Error(
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
          );
        }
      },
    });
    harness.setFlag("goal", "Headless goal");

    // Must not throw out of session_start.
    await harness.handlers.get("session_start")!(
      { type: "session_start", reason: "startup" },
      harness.ctx,
    );

    // Goal is still persisted.
    expect((await expectSavedGoal(harness.home)).goal).toBe("Headless goal");

    // It was delivered via a queued follow-up (the only send that survived).
    expect(harness.sentUserMessages).toEqual([
      { text: "Headless goal", options: { deliverAs: "followUp" } },
    ]);
  });
});

describe("gate-pass circuit breaker", () => {
  test("raises the thinking level to high once on the GOAL_GATE_ESCALATE_AT-th consecutive gate pass", async () => {
    const harness = await createHarness();
    await harness.commands.get("goal")!.handler("Keep nudging", harness.ctx);

    // Three consecutive gate passes with no edit/write in between.
    for (let i = 0; i < 3; i++) {
      harness.handlers.get("agent_end")!({ messages: [] }, harness.ctx);
      await waitForDeferredCallbacks();
    }

    // Escalates exactly once at pass 3; default max (6) not reached, so no abort.
    expect(harness.thinkingLevels).toEqual(["high"]);
    expect(harness.abortCount).toBe(0);
    expect((await expectSavedGoal(harness.home)).isActive).toBe(true);
  });

  test("hard-stops the gate and aborts after --goal-max-gate-passes consecutive passes", async () => {
    const harness = await createHarness();
    harness.setFlag("goal-max-gate-passes", "3");
    await harness.commands.get("goal")!.handler("Loops forever", harness.ctx);

    for (let i = 0; i < 3; i++) {
      harness.handlers.get("agent_end")!({ messages: [] }, harness.ctx);
      await waitForDeferredCallbacks();
    }

    // The hard-stop continuation awaits saveGoal() before calling ctx.abort(),
    // so once the persisted goal is observably inactive, abort has run too.
    const persisted = await waitForSavedGoal(harness.home, (g) => !g.isActive);
    expect(persisted.isActive).toBe(false);
    expect(persisted.completionSummary).toContain("hard-stopped");
    expect(harness.abortCount).toBe(1);
  });

  test("resets the pass counter on edit/write tool execution so productive work is never hard-stopped", async () => {
    const harness = await createHarness();
    harness.setFlag("goal-max-gate-passes", "3");
    await harness.commands.get("goal")!.handler("Productive goal", harness.ctx);

    // Two stuck passes...
    for (let i = 0; i < 2; i++) {
      harness.handlers.get("agent_end")!({ messages: [] }, harness.ctx);
      await waitForDeferredCallbacks();
    }
    // ...then genuine code progress resets the counter...
    harness.handlers.get("tool_execution_end")!(
      { type: "tool_execution_end", toolCallId: "t", toolName: "edit", result: {}, isError: false },
      harness.ctx,
    );
    // ...so two more passes do NOT reach the max of 3.
    for (let i = 0; i < 2; i++) {
      harness.handlers.get("agent_end")!({ messages: [] }, harness.ctx);
      await waitForDeferredCallbacks();
    }

    expect(harness.abortCount).toBe(0);
    expect((await expectSavedGoal(harness.home)).isActive).toBe(true);
  });
});

describe("exec-verified completion gate", () => {
  const makeProject = (files: Record<string, string>) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-proj-"));
    homesToRemove.push(dir);
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    return dir;
  };
  const validEvidence = {
    summary: "Done.",
    requirementsCovered: "- X → slug.ts:1",
    verificationsRun: "ran tests",
    taskEvidence: "n/a",
    shortcutsConsidered: "none",
  };

  test("blocks goal_complete when a verification command exits non-zero and routes the failure back", async () => {
    const cwd = makeProject({ ".pi-goal.json": JSON.stringify({ validate: ["run-the-suite"] }) });
    const harness = await createHarness(undefined, {
      cwd,
      exec: () => ({ stdout: "", stderr: "BOOM: 1 test failed", code: 1, killed: false }),
    });
    await harness.commands.get("goal")!.handler("Pass the suite", harness.ctx);

    const result = await harness.executeTool("goal_complete", validEvidence);

    expect(result.content[0].text).toContain("COMPLETION BLOCKED");
    expect(result.content[0].text).toContain("BOOM: 1 test failed");
    expect(result.content[0].text).toContain("run-the-suite");
    expect(result.details.error).toBe("Completion blocked: verification failed");
    // Not completed: goal stays active.
    expect((await expectSavedGoal(harness.home)).isActive).toBe(true);
    // The command was actually run via a shell in the project cwd, with the
    // project's local bin prepended to PATH so locally-installed tools resolve.
    expect(harness.execCalls).toHaveLength(1);
    expect(harness.execCalls[0]!.command).toBe("bash");
    const shellScript = (harness.execCalls[0]!.args as string[])[1]!;
    expect(shellScript).toContain("run-the-suite");
    expect(shellScript).toContain("node_modules/.bin");
    expect((harness.execCalls[0]!.options as { cwd: string }).cwd).toBe(cwd);
  });

  test("accepts goal_complete when all verification commands pass", async () => {
    const cwd = makeProject({ ".pi-goal.json": JSON.stringify({ validate: ["bun test", "tsc --noEmit"] }) });
    const harness = await createHarness(undefined, {
      cwd,
      exec: () => ({ stdout: "ok", stderr: "", code: 0, killed: false }),
    });
    await harness.commands.get("goal")!.handler("Green build", harness.ctx);

    const result = await harness.executeTool("goal_complete", validEvidence);

    expect(result.content[0].text).toContain("Goal marked complete");
    expect(result.content[0].text).toContain("Verified by 2 command(s): all passed.");
    expect((await expectSavedGoal(harness.home)).isActive).toBe(false);
    expect(harness.execCalls).toHaveLength(2);
  });

  test("discovers commands from package.json scripts (typecheck/test/lint) when no .pi-goal.json exists", async () => {
    const cwd = makeProject({
      "package.json": JSON.stringify({
        scripts: { typecheck: "tsc --noEmit", test: "bun test", build: "tsc", lint: "eslint ." },
      }),
    });
    const harness = await createHarness(undefined, {
      cwd,
      exec: () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    });
    await harness.commands.get("goal")!.handler("Use package scripts", harness.ctx);

    await harness.executeTool("goal_complete", validEvidence);

    // Only typecheck/test/lint scripts are run (not "build"), in that order;
    // each is wrapped with the local-bin PATH prefix.
    const ran = harness.execCalls.map((c) => (c.args as string[])[1]!);
    expect(ran).toHaveLength(3);
    expect(ran[0]).toContain("tsc --noEmit");
    expect(ran[1]).toContain("bun test");
    expect(ran[2]).toContain("eslint .");
    expect(ran.some((s) => s.includes("build"))).toBe(false);
  });

  test("--goal-no-exec-gate opt-out skips verification entirely", async () => {
    const cwd = makeProject({ ".pi-goal.json": JSON.stringify({ validate: ["would-fail"] }) });
    const harness = await createHarness(undefined, {
      cwd,
      exec: () => ({ stdout: "", stderr: "nope", code: 1, killed: false }),
    });
    harness.setFlag("goal-no-exec-gate", true);
    await harness.commands.get("goal")!.handler("Skip the gate", harness.ctx);

    const result = await harness.executeTool("goal_complete", validEvidence);

    expect(harness.execCalls).toHaveLength(0);
    expect(result.content[0].text).toBe("Goal marked complete: Done.");
    expect((await expectSavedGoal(harness.home)).isActive).toBe(false);
  });

  test("re-discovers validation commands when the goal is replaced (no stale cache)", async () => {
    const cwd = makeProject({ ".pi-goal.json": JSON.stringify({ validate: ["check-A"] }) });
    const harness = await createHarness(undefined, {
      cwd,
      exec: () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    });

    await harness.commands.get("goal")!.handler("First goal", harness.ctx);
    await harness.executeTool("goal_complete", validEvidence);
    expect((harness.execCalls.at(-1)!.args as string[])[1]).toContain("check-A");

    // Change the project's validation commands, then replace the goal. The
    // cached command list must be invalidated so the new commands are used.
    fs.writeFileSync(
      path.join(cwd, ".pi-goal.json"),
      JSON.stringify({ validate: ["check-B"] }),
    );
    await harness.commands.get("goal")!.handler("Second goal", harness.ctx);
    await harness.executeTool("goal_complete", validEvidence);

    expect((harness.execCalls.at(-1)!.args as string[])[1]).toContain("check-B");
  });
});
