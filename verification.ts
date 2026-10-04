import type { GoalJson, GoalTask } from "./goalManager.ts";

// Optional extension protocol, transported by Pi's documented shared event bus.
// Discovery is synchronous; the returned review function is explicitly awaited.
export const GOAL_VERIFIER_CHANNEL = "goal:verifier";

export interface CompletionVerdict {
  pass: boolean;
  feedback: string;
}

export interface ValidationEvidence {
  command: string;
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export interface CompletionReview {
  cwd: string;
  goal: GoalJson;
  task?: GoalTask;
  evidence?: Record<string, string>;
  contract: {
    evidenceFields: Record<string, string>;
    validationCommands: string[];
  };
  validationResults?: ValidationEvidence[];
  history: unknown[];
  signal?: AbortSignal;
}

export type ReviewCompletion = (review: CompletionReview) => Promise<CompletionVerdict>;

export interface VerifierDiscovery {
  sessionId: string;
  provide(review: ReviewCompletion): void;
}
