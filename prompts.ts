import type { GoalJson, GoalTask } from "./goalManager.ts";

export const GOAL_COMPLETION_GATE_HEADING = "GOAL COMPLETION GATE";

const formatGoalTaskLine = (task: GoalTask) =>
  `- [${task.isComplete ? "x" : " "}] #${task.id}: ${task.text}`;

const getNextGoalTask = (goal: GoalJson) =>
  goal.tasks.find((task) => !task.isComplete);

const formatGoalTaskList = (goal: GoalJson) =>
  goal.tasks.length ?
    goal.tasks.map(formatGoalTaskLine).join("\n")
  : "- No tracked tasks yet.";

const formatNextGoalAction = (goal: GoalJson) => {
  const nextTask = getNextGoalTask(goal);
  if (nextTask) return `#${nextTask.id}: ${nextTask.text}`;

  if (goal.tasks.length > 0) {
    return "No incomplete tracked tasks. Verify the goal is truly complete; goal_complete requires structured evidence in every field — read the tool description before calling.";
  }

  return "No tracked tasks yet. Create goal_task items if useful, then work on the most important next action toward the goal.";
};

export const formatGoalState = (goal: GoalJson) => `<goal_state critical="true">
Current goal: ${goal.goal}

Current tasks:
${formatGoalTaskList(goal)}

Next task/action: ${formatNextGoalAction(goal)}

Instruction: Treat this as the latest source of truth for the active goal. Continue with the next incomplete task. If no incomplete tasks remain, do not stop — call goal_complete and fill every required evidence field with concrete artifacts (file:line, exact test names, exact command output). The tool's schema is the audit; vague answers there mean the goal is not done.
</goal_state>`;

export const formatGoalMissionPrompt = () => `<goal critical="true">
You are an agent on a mission to achieve the active goal. Fresh goal status is injected in <goal_state> before each LLM call; treat that status as the source of truth for current tasks and next action.

Do not stop until the goal is achieved. Completion is signalled exclusively by calling goal_complete with all required evidence fields populated with concrete artifacts. Read the goal_complete tool description before calling — it specifies what counts as evidence and what counts as a shortcut.
</goal>`;

// Slim gate: the schema of goal_complete is the actual audit. The gate's job
// is just to prevent a premature stop and route the agent back to either
// continuing or calling goal_complete with structured evidence. We
// deliberately do NOT inline the audit checklist here, because that
// duplicates (and inevitably drifts from) the tool's parameter descriptions,
// and because asking the agent to mentally re-check a long checklist on top
// of filling structured evidence fields is exactly the kind of fragile,
// procedural step the redesign avoids.
export const formatGoalCompletionGateMessage = (
  goal: GoalJson,
) => `${GOAL_COMPLETION_GATE_HEADING}: You reached the end of an agent run while an active goal remains.

${formatGoalState(goal)}

Do not stop. Do exactly one of:

1. Continue working if anything is incomplete, uncertain, unverified, or low-confidence. Add or reopen goal_task items as needed and run the next concrete step.
2. Call goal_complete and fill every required evidence field with concrete artifacts. The tool description spells out what counts as evidence and what counts as a shortcut; an empty, vague, or generic value in any field means the goal is not yet complete and you should keep working instead.

Do not summarise prior work in this turn in lieu of one of the two actions above.`;

// Persist the structured-evidence payload from goal_complete as a single
// labelled markdown blob. We keep the SQLite schema (`completionSummary
// TEXT`) unchanged and just serialise into it — the structured fields are
// authoritative at call time (the LLM API enforces presence) and only need
// to be human-readable on disk.
export const formatGoalCompletionEvidence = (params: {
  summary: string;
  requirementsCovered: string;
  verificationsRun: string;
  taskEvidence: string;
  shortcutsConsidered: string;
}) =>
  [
    `Summary: ${params.summary}`,
    "",
    "Requirements covered:",
    params.requirementsCovered,
    "",
    "Verifications run:",
    params.verificationsRun,
    "",
    "Task evidence:",
    params.taskEvidence,
    "",
    "Shortcuts considered:",
    params.shortcutsConsidered,
  ].join("\n");
