# pi-goal improvement pass — results

Goal: explore, via parallel worktree experiments, ideas that raise the quality
of an AI agent's output when working toward a goal — then merge the best.

This documents the full pipeline (research → ideate → evaluate → experiment →
merge) and what actually shipped. It is deliberate about distinguishing
*measured* facts from *designed* methodology (see the honesty notes).

## What shipped on `main`

Two independent, adversarially-reviewed upgrades, both validated by a
deterministic unit suite (39 tests, 0 fail, `tsc --noEmit` clean):

1. **Core gate variant** (`feat`: headless fix + circuit breaker + exec-verified
   completion gate). Consensus #1 + #2 from the vote.
   - *Headless injection fix*: `sendGoalUserMessage` never bare-sends; it always
     passes a `deliverAs`, so `pi -p`/CI no longer dies on startup with
     "Agent is already processing".
   - *Exec-verified completion gate*: `goal_complete` runs the project's own
     verification commands (`.pi-goal.json` `validate`, else `package.json`
     `typecheck`/`test`/`lint`) via `pi.exec` and **blocks completion on any
     non-zero exit**, routing the failing output back. Completion becomes
     machine-checked exit codes, not self-narrated prose. `--goal-no-exec-gate`
     opts out; commands run with `node_modules/.bin` on PATH.
   - *Gate-pass circuit breaker*: bounds the completion gate — escalates the
     thinking level once at 3 consecutive stuck passes and hard-stops
     (`ctx.abort()`) at `--goal-max-gate-passes` (default 6). The counter resets
     on genuine code progress (`edit`/`write`), so productive multi-turn work is
     never penalised. This is the prerequisite that makes the exec gate safe.

2. **Scope-enforcement variant**. Consensus #3.
   - `goal_scope` tool declares an allow/deny glob scope; a `tool_call` hook
     **hard-blocks** out-of-scope `edit`/`write` before they run, and a
     `<goal_scope>` reminder is injected each turn. Paths are cwd-normalized and
     `..`-collapsed so traversal can't slip past an allowlist. Attacks scope
     creep — the most common coding-agent failure mode.

A pre-existing **critical bug** was fixed first: the runtime imports referenced
`@mariozechner/*` while the installed packages are `@earendil-works/*`, so 22/23
tests failed with "Cannot find module". After the fix the baseline is green.

## How "good" is measured (`docs/EVALUATION.md`)

Six dimensions: outcome (oracle pass), iterations (turn count), token/cost,
duration, test/lint pass, scope adherence, completion honesty. Headline rule:
efficiency only counts among runs that actually pass the outcome oracle; a fast
broken "done" scores zero. A real runner (`eval/run-eval.ts`) drives `pi -p`,
parses the JSONL for turns/tokens/cost/`goal_complete`, runs the task oracle,
and checks scope against an allowlist. A benchmark task (`eval/tasks/slugify`)
exercises completion-honesty + scope + verification pressure.

## Measured datapoint (headless startup)

`bun eval/run-eval.ts --variant index.ts --task slugify` (model
`xai-auth/grok-composer-2.5-fast`):

| State | `pi -p --goal …` exit | startup crash |
| --- | --- | --- |
| Baseline (`@earendil` fix only) | 1 | yes — "Agent is already processing" |
| After core variant | 0 | no |

The crash is eliminated. (Token/iteration efficiency of the gate itself is not
in this table — see the honesty note below.)

## Honesty notes / known limitations

- **`pi -p` does not run the goal LOOP.** Print mode executes exactly the
  positional prompt as one agent loop and exits; it does not pump
  extension-injected turns (neither the `session_start` goal injection nor the
  `agent_end` gate follow-up fire as turns). So end-to-end, multi-turn
  benchmarking of the completion gate is **not possible via `pi -p`** in this
  environment. The gate, circuit breaker, and exec-verification are therefore
  validated by the deterministic unit harness (which simulates the lifecycle
  events directly) rather than by full agent benchmark runs. `tool_call` /
  `tool_result` hooks *do* fire during the single print-mode turn, so the scope
  block is also reachable live. This is a property of pi's print mode, not of
  the extension; the goal LOOP works in interactive mode.
- **Comparative agent-quality benchmarking** (variant vs baseline across
  tasks × seeds) is designed in `docs/EVALUATION.md` but not run at scale here:
  it requires many full multi-turn sessions and is gated by the print-mode
  limitation above. No such numbers are claimed.
- **Scope is a drift guardrail, not a sandbox**: bash-based writes are not
  intercepted (documented in code + AGENTS.md).

## Process artifacts

- `docs/RESEARCH.md` / `research-findings.json` — SOTA brief (6 parallel
  research streams + synthesis): Factory missions, Codex/AGENTS.md, Claude Code,
  Cursor continual-learning, env-pressure; 20 ranked candidates.
- `docs/IDEATION.md` — 42-idea pool from 7 lenses, scored by 5 independent
  judges; code-grounded decision memo that picked the core + scope work.
- Worktrees `exp/headless-fix` (core) and `exp/scope-enforcement` were developed
  and tested in isolation, then merged.

## Deferred (next worktrees, per the ideation memo)

Reflexion failure-memory (#5, depends on the exec gate's rejection signal),
mandatory plan-and-solve planning phase (#19), and PostToolUse inline
lint/typecheck steering (#2, needs an empirical check that modified
`tool_result` content reaches the model under each provider).
