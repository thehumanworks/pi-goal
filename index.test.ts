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

type TestHarness = {
  home: string;
  commands: Map<string, RegisteredCommand>;
  handlers: Map<string, Function>;
  tools: Map<string, RegisteredTool>;
  sentUserMessages: Array<{ text: string; options?: unknown }>;
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

const createHarness = async (existingHome?: string): Promise<TestHarness> => {
  const home =
    existingHome ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-extension-"));
  if (!existingHome) homesToRemove.push(home);
  process.env.HOME = home;

  const commands = new Map<string, RegisteredCommand>();
  const handlers = new Map<string, Function>();
  const tools = new Map<string, RegisteredTool>();
  const flags = new Map<string, unknown>();
  const sentUserMessages: Array<{ text: string; options?: unknown }> = [];

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
      sentUserMessages.push({ text, options });
    },
  } as unknown as ExtensionAPI;

  const { default: registerGoalExtension } = await import(
    `./index.ts?test=${Date.now()}-${Math.random()}`
  );
  registerGoalExtension(pi);

  const ctx = {
    hasUI: true,
    isIdle: () => true,
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
        options: undefined,
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
    expect(harness.sentUserMessages).toEqual([
      { text: "Reach the flagged goal", options: undefined },
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
    expect(complete.content[0].text).toBe(
      "Goal marked complete: All work is done and verified.",
    );
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
