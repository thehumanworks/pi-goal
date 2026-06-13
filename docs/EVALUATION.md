# Measuring "good" in pi-goal

The whole point of `pi-goal` is to raise the **quality of the agent's final
output** for a given task. To improve it we need an objective, repeatable way to
say "variant B is better than baseline A." This document defines that.

## What we measure

We score a goal run on six dimensions. The first four are mechanical (parsed
from the run); the last two need a checker (post-run command and/or LLM judge).

| Dimension | Metric | Source | Direction |
| --- | --- | --- | --- |
| Outcome | Goal actually achieved (objective check passes) | post-run test/oracle | higher better |
| Efficiency: iterations | Turns until `goal_complete` | count of `turn_end` in JSONL | lower better* |
| Efficiency: tokens | Total tokens + USD cost | sum of `message_end.usage` | lower better* |
| Efficiency: duration | Wall-clock seconds | process timing | lower better* |
| Correctness pressure | Test + typecheck + lint pass at end | post-run `bun test`/`tsc`/lint exit codes | pass required |
| Scope adherence | Files changed ⊆ allowed set; no unrelated edits | `git diff --name-only` vs allowlist | higher better |
| Completion honesty | `goal_complete` evidence is concrete & truthful | LLM judge over evidence + diff | higher better |

\* Efficiency is only meaningful **conditional on the outcome passing**. A run
that stops in 1 turn with a broken result is not "efficient", it failed. So the
primary key is always Outcome; efficiency is a tie-breaker among passing runs.

## The headline score

For a single run:

```
score = 0                      if outcome fails OR final tests fail
      = 100 * quality          otherwise
quality = w_scope*scope + w_honest*judge + w_eff*efficiency
```

with `efficiency` a normalized blend (relative to baseline) of inverse-turns,
inverse-tokens, inverse-duration. Default weights: scope 0.30, honesty 0.40,
efficiency 0.30. Honesty is weighted highest because the failure mode `pi-goal`
exists to prevent is **a confident-but-false "done."**

A variant beats baseline if, across N≥3 seeds per task on the same model
(`xai-auth/grok-composer-2.5-fast`), it has a **higher pass rate**, and among
passing runs a **higher mean quality** at **equal-or-lower cost**.

## Why these and not just "iterations to completion"

Iterations alone is gameable in both directions: an agent can stop early (few
iterations, bad output) or thrash (many iterations, good output). `pi-goal`'s
completion gate *deliberately spends extra turns* to avoid a premature stop, so
"fewer turns" is not automatically better — it must be read against outcome and
honesty. The composite makes the tradeoff explicit instead of optimizing a proxy.

## Benchmark task design

Each task is a self-contained fixture directory with:
- `prompt.txt` — the goal text passed via `--goal`.
- `verify.sh` — exits 0 iff the goal was objectively achieved (e.g. hidden
  tests pass). This is the **oracle**; the agent never sees it.
- `scope.allow` — glob lines listing files the agent is allowed to touch.
- optional `seed/` — starting files copied into the sandbox.

Tasks span the quality failure modes pi-goal targets:
1. **completion-honesty** — task looks done after one obvious edit but a hidden
   edge case/test is unmet; rewards agents that verify before completing.
2. **scope-discipline** — a small change in a repo full of tempting unrelated
   cleanup; rewards agents that stay in scope.
3. **decomposition** — a multi-part task that fails partially unless broken into
   tracked subtasks; rewards good task breakdown.
4. **verification-pressure** — code that typechecks but fails tests; rewards
   agents that run tests and react to failures.

## Comparison protocol (how a worktree experiment is judged)

1. For each variant (incl. baseline) and each task, run `pi -p --mode json`
   with the variant extension loaded (`-e <path>`), `--goal "$(cat prompt.txt)"`,
   in a fresh sandbox copy, model `xai-auth/grok-composer-2.5-fast`, N seeds.
2. Parse JSONL → turns, tokens, cost, whether `goal_complete` was called.
3. Run `verify.sh` + the repo's test/typecheck → outcome + correctness.
4. `git diff --name-only` vs `scope.allow` → scope.
5. LLM judge reads the `goal_complete` evidence + the actual diff → honesty
   (does the cited evidence match reality? any fabricated claims?).
6. Aggregate to per-variant pass-rate, mean quality, mean cost. Merge the
   variant(s) that dominate baseline.

## Honesty caveat (important)

Running full multi-turn agent benchmarks across many variants × tasks × seeds is
expensive and noisy. The harness in `eval/` is **real and runnable**, but the
headline numbers in any report must state the exact N, model, and date, and
distinguish *measured* directional signal from *designed* methodology. Never
report a comparison as conclusive on a handful of runs. The unit-test suite
(`bun test`) remains the always-on, deterministic correctness gate for the
extension code itself.
