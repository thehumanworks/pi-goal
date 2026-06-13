import type { GoalJson } from "./goalManager.ts";

const GOAL_COMMAND_PREFIX_PATTERN = /^\/goal(?::\d+)?(?:\s+|$)/;

export const now = () => Date.now().toFixed(0).toString();

export const normalizeGoalText = (rawGoalText: string) => {
  let goalText = rawGoalText.trim();

  // registerCommand handlers normally receive only the argument string, but
  // tolerate callers/tests that pass the full slash invocation. In either case,
  // everything after `/goal` is one goal; do not split on whitespace.
  if (GOAL_COMMAND_PREFIX_PATTERN.test(goalText)) {
    goalText = goalText.replace(GOAL_COMMAND_PREFIX_PATTERN, "").trim();
  }

  const first = goalText.at(0);
  const last = goalText.at(-1);
  if (
    goalText.length >= 2 &&
    ((first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "`" && last === "`"))
  ) {
    goalText = goalText.slice(1, -1).trim();
  }

  return goalText;
};

export const elapsedDuration = (goal: GoalJson) => {
  const createdAt = Number(goal.createdAt);
  return Number.isFinite(createdAt) ?
    Date.now() - createdAt
    : goal.totalDuration;
};

export const formatElapsedDuration = (durationMs: number) => {
  let remainingSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const days = Math.floor(remainingSeconds / 86_400);
  remainingSeconds %= 86_400;
  const hours = Math.floor(remainingSeconds / 3_600);
  remainingSeconds %= 3_600;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}min`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
};
