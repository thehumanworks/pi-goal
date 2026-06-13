I now have everything I need, and crucially I've found that several panel claims contradict the actual code. The memo must correct these because they change which idea ranks first and what the deterministic tests actually look like. Let me note the key discrepancies before writing.

Key findings from the real code:
1. **Panel's #36 premise is partly wrong.** The `agent_end` handler already uses `deliverAs: "followUp"` (index.ts:521-523), not a bare `sendUserMessage`. The "bare sendUserMessage throws at line 234" claim is about `session_start`/`/goal`, where `sendGoalUserMessage(nextGoal, ctx.isIdle())` sends with NO `deliverAs` when `isIdle===true` (index.ts:180-187). So the headless bug is real but lives only in the initial goal injection, not the gate loop.
2. **No `gatePassCount`, no `ctx.abort`, no `setThinkingLevel`, no `pi.exec` anywhere** in code or harness. The harness `pi` object has only `registerFlag/getFlag/registerCommand/registerTool/on/sendUserMessage`. Any exec/abort/thinking test requires adding those stubs to the harness first.
3. **No `tool_call`/`tool_result` hooks are registered.** Those ideas (#2/#15/#19) start from zero.
4. The completion gate is purely schema-based; `goal_complete.execute` (index.ts:276-301) sets `isActive=false` with no validation — exactly the self-certification gap #1/#14/#42 target.
5. Tests pass: 23/23, 133 expects.

I have enough to write a decisive, code-grounded memo.

# Decision Memo: pi-goal Extension — Improvements to Prototype

**Author:** engineering review of `pi-goal-extension` (commit `e0845ec`)
**Status:** all 23 existing tests green (`bun test`: 23 pass, 133 expect). Memo grounded in the actual `index.ts` / `index.test.ts`, not just the ideation panel.

---

## 0. Code-reality corrections (read this first — it reorders the panel's priorities)

I read the source before trusting the panel. Three of the panel's load-bearing claims are stale, and they change the plan:

- **The headless bug is narrower than #36 describes.** The panel repeatedly claims the `agent_end` continuation sends a bare `sendUserMessage` and that "line 234" crashes the loop. In the current code the `agent_end` handler already uses `deliverAs: "followUp"` (`index.ts:521`), and there is an existing test covering it (`index.test.ts:341`). The *real* defect is isolated to the **initial goal injection**: `sendGoalUserMessage(nextGoal, ctx.isIdle())` (`index.ts:234`, `:266`) sends with **no `deliverAs`** when `ctx.isIdle()` returns `true`. In `pi -p` a prompt is queued-but-not-yet-processing, so `isIdle()` is `true` while the agent is about to run, and the bare `sendUserMessage` throws "Agent is already processing." So #36's Fix 1 is correct and worth doing; #41's `agent_end` rework is largely already done and should be descoped.
- **There is no circuit breaker, and none of its primitives are wired.** There is no `gatePassCount`, and `pi.exec`, `ctx.abort`, and `pi.setThinkingLevel` appear **nowhere** in `index.ts` or the test harness. The harness `pi` object exposes only `registerFlag/getFlag/registerCommand/registerTool/on/sendUserMessage` (`index.test.ts:59-78`) and `ctx` exposes only `hasUI/isIdle/sessionManager/ui`. **Every exec/abort/thinking-level idea requires extending the harness first.** That is cheap but it is real work the panel did not cost.
- **No `tool_call` or `tool_result` hook is registered today.** The inline-lint and planning-gate ideas start from zero hooks, and the panel itself flags the open question of whether modified `tool_result` content reaches the model across providers. That risk is unverified in this repo.

These corrections mean the safe, high-value core is: **fix the real headless injection bug, add the circuit breaker, and make completion machine-checked.** The inline-lint and planning-phase ideas are higher-risk and belong in isolated spikes, not the core.

---

## 1. Top improvements to prototype (parallel worktrees)

Each row: one-line spec, the pi hook, the deterministic test that proves it, expected quality impact. Prototypes are ordered by value-per-risk.

### A. Fix the real headless-mode goal injection (`session_start` / `/goal`)
- **Spec:** In `sendGoalUserMessage`, always deliver with `deliverAs: "steer"` when `!ctx.isIdle()`, and stop trusting `isIdle()===true` as "safe to bare-send" in print mode. Concretely: pass the headless signal through and use `steer` whenever the agent is or may be processing, mirroring the `agent_end` path that already does this.
- **Hook:** `session_start` and the `/goal` command handler (both call `sendGoalUserMessage`, `index.ts:234`/`:266`).
- **Deterministic test:** build a harness where `ctx.isIdle = () => false`; fire `session_start` with the `--goal` flag set; assert `sentUserMessages[0].options` equals `{ deliverAs: "steer" }` and that no exception was thrown. Add a symmetric test for the `/goal` command. (The harness's `sendUserMessage` already records `{text, options}`, so no harness change is needed for this one.)
- **Impact:** High. This is a correctness fix: without it, every `pi -p` / CI run dies with zero turns. It unblocks the autonomous mode the whole extension exists to serve.

### B. Gate-pass circuit breaker with thinking-level escalation
- **Spec:** Module-scoped `gatePassCount`, reset in `setGoal`/`adoptPersistedGoal`, incremented each time the `agent_end` continuation fires on a still-active goal. At pass 3 call `pi.setThinkingLevel("high")`; at pass N (default 6, configurable via a `--goal-max-gate-passes` flag) call `ctx.abort()` with a diagnostic and set `goal.isActive = false`.
- **Hook:** `agent_end` (counter + escalation + hard stop); a new `--goal-max-gate-passes` flag via `registerFlag`.
- **Deterministic test:** extend the harness `ctx` with `abort` and `pi` with `setThinkingLevel` as recording mocks. Set N=3, set an active goal, call the `agent_end` handler 3 times (awaiting `waitForDeferredCallbacks()` between each, since the continuation is deferred via `setTimeout(…,0)`). Assert `setThinkingLevel` was called with `"high"` and `ctx.abort` fired on the 3rd pass with `goal.isActive === false`. Add a test that `setGoal` resets the counter to 0.
- **Impact:** Medium-high. Pure safety: prevents an infinite, billing-burning gate loop. This is a **hard prerequisite** for shipping any blocking gate (C below), because an always-failing exec check would otherwise loop forever.

### C. Exec-verified completion gate (consolidation of #1 / #14 / #42)
- **Spec:** Inside `goal_complete.execute`, **before** setting `goal.isActive = false`, run validation commands discovered (in priority order) from `.pi-goal.json` → a `[pi-goal]` block in `AGENTS.md` → `package.json` test/typecheck scripts → `Makefile test` target. Run each via `pi.exec` with a per-command timeout (default 60s). If any exits non-zero, do **not** complete: return a tool result whose text is prefixed `COMPLETION BLOCKED:` and embeds the failing command, exit code, and truncated stdout/stderr, and set `pendingGateInjection = true` so the failure also arrives via the `context` channel. If no commands are discoverable, complete with a "no validation commands found" warning (graceful degradation). Add a `--goal-no-exec-gate` opt-out flag.
- **Hook:** `goal_complete.execute` + `pi.exec`; command discovery cached at `session_start`.
- **Deterministic test:** add a `pi.exec` mock to the harness that records invocations and returns a scripted `{code, stdout, stderr}`. Test 1: exec returns code 1 → assert `content[0].text` contains `COMPLETION BLOCKED` and the stderr, and `expectSavedGoal(...).isActive === true` (not completed). Test 2: exec returns code 0 → assert `isActive === false`. Test 3: no commands discoverable → assert `pi.exec` is never called and completion still succeeds with the warning text.
- **Impact:** High. This is the single largest quality lever after the headless fix. Today `goal_complete` accepts self-narrated `verificationsRun` prose with nothing actually run (`index.ts:276-301`). Making completion gated on real exit codes closes the "I tried my best" escape hatch (SWE-bench fail-to-pass / Factory exit-code precedent). **Necessary but not sufficient** — keep the structured-evidence schema; ~31% of test suites pass weak patches.

### D. Reflexion failure memory on gate rejection (#5)
- **Spec:** New SQLite table `gate_rejections(session_id, rejected_at, rejection_reason, attempted_evidence)`. When a `goal_complete` call is rejected (by C's exec gate) or the gate re-fires after a prior rejection, synthesize a three-field post-mortem (`what_was_attempted` / `what_was_missing` / `what_to_do_differently`, each demanding file:line specificity) and persist it. In `before_agent_start`, prepend up to the 3 most recent reflections as a `<prior_attempts>` block, capped per-reflection (~400 chars).
- **Hook:** `goal_complete.execute` (log rejection) + `agent_end` (synthesize) + `before_agent_start` (inject); new SQLite table.
- **Deterministic test:** drive a rejection (via C's failing exec mock), fire `agent_end`, assert a `gate_rejections` row with non-empty fields is written; fire `before_agent_start` and assert the returned `systemPrompt` contains `<prior_attempts>` with the reflection text; after 4 rejections, assert only the 3 most recent appear. The reflection synthesizer must be stubbed (inject it as a dependency) so the test stays deterministic and offline.
- **Impact:** Medium-high. Strong evidence base (Reflexion, 91% vs 68% on HumanEval). Stops the agent re-reading identical context and repeating the same miss after each rejection. Depends on C existing to produce real rejection signals.

### E. Mandatory plan-and-solve planning phase (#19)
- **Spec:** Add a `planningPhase` boolean to in-memory goal state and a `planning_phase INTEGER NOT NULL DEFAULT 0` column to the `goals` table. New goal starts in planning. Extend `formatGoalState` with a `<planning_mode>` section instructing the agent to enumerate subtasks via `goal_task add`, then call a new zero-param `goal_planning_complete` tool. While planning, a `tool_call` hook blocks write-side tools (configurable name set) with `{block:true, reason:…}`. `goal_task` add/remove stays available after planning to allow re-planning.
- **Hook:** `tool_call` (block writes during planning) + `context` (planning-mode instructions) + new `goal_planning_complete` tool + `goalManager.ts` schema migration.
- **Deterministic test:** create a goal, assert `planningPhase === true`; fire a fake `tool_call` event with a write-tool name, assert it returns `{ block: true }`; fire `goal_planning_complete`, assert `planningPhase === false` and the same write `tool_call` is no longer blocked; assert `<planning_mode>` appears in the `context` injection only while planning.
- **Impact:** Medium-high (Plan-and-Solve, +8pp on reasoning), but it changes the interaction model and the write-tool name list is fragile against pi's real tool names. Isolate it.

### F. (Spike only) PostToolUse inline lint/typecheck steering (consolidation of #2 / #15 / #25 / #33)
- **Spec:** Register a `tool_call` hook to ring-buffer `{toolCallId → filePath}`, and a `tool_result` hook that, on write/edit tools, runs a fast targeted check (`tsc --noEmit --isolatedModules <file>` / `eslint <file>`) via `pi.exec`, and on non-zero exit appends a `<lint_result>…</lint_result>` text block to the result content. Batch-write guard: at most 3 checks per turn, 5–10s timeout, exit-code-only filtering.
- **Hook:** `tool_call` (path ring buffer) + `tool_result` (modify content) + `pi.exec`.
- **Deterministic test:** fire a `tool_result` with `toolName="Write"` and a `.ts` path in the buffered `tool_call`; exec mock returns code 1 with a `TS2345…` string → assert the returned content array gained a `<lint_result>` block containing it. Exec returns code 0 → assert content is unchanged. Fire 4 writes in one turn → assert `pi.exec` called at most 3 times.
- **Impact:** Potentially high (turns the end-gate into per-edit pressure), **but** gated on an unverified assumption: that modified `tool_result` content actually reaches the model under pi's providers (AGENTS.md flags cursor-agent strips synthetic bodies). If injection is dropped, this is a no-op. Treat as a research spike with an empirical smoke test before any reliance.

---

## 2. What can be combined vs must be isolated

**Combine into one "core correctness + safety" worktree (ship together):**
- **A (headless fix) + B (circuit breaker) + C (exec gate).** These are mutually reinforcing and share the harness extension work (adding `pi.exec`, `ctx.abort`, `setThinkingLevel` mocks). C is unsafe to ship without B (an always-failing check loops forever). A is independent but tiny and touches the same lifecycle file. This is the canonical first PR.

**Build on the core, separate worktree:**
- **D (Reflexion memory)** depends on C producing real rejection events. Branch it off the core branch once C's rejection path exists. It adds a new SQLite table, so it must not race C's `goal_complete` changes — sequence D after C.

**Isolate (do not combine):**
- **E (planning phase)** changes the interaction model and adds a `tool_call` block path and a schema migration. Keep it in its own worktree so a fragile write-tool-name list cannot destabilize the core gate.
- **F (inline lint)** is a research spike with an unverified provider assumption. Isolate it entirely; its `tool_result` modification must be empirically validated against the real provider before it is allowed near the core.

**Shared dependency to land first in core:** the harness extension that adds recording mocks for `pi.exec`, `ctx.abort`, and `pi.setThinkingLevel`. B, C, D, E, and F all need some subset; landing it once in the core branch and rebasing the others avoids three divergent harness forks.

---

## 3. Non-goals / rejected ideas (and why)

- **#41 "headless single-pass gate / `deliverAs:'steer'` in `agent_end`":** mostly already implemented. `agent_end` already uses `deliverAs:"followUp"` (`index.ts:521`) with a passing test (`index.test.ts:341`). The genuine residual fix is the *initial* injection (idea A), so #41 collapses into A. Rejected as a standalone item to avoid re-doing solved work.
- **The duplicate exec-gate trio (#1, #14, #42):** these are the same feature with different discovery strategies. Implement **once** (idea C), borrowing #42's `.pi-goal.json` explicit config, #14's priority-ordered discovery, and (optionally) #14's `validation_runs` audit table. Do not open three worktrees.
- **The duplicate inline-lint quartet (#2, #15, #25, #33):** same mechanism. Implement once (idea F). Reject #25's "spawn a full `pi -p` subagent per write" variant specifically: spawning a headless session per edit is 5–30s of latency per write and depends on the headless fix landing first — far higher cost for the same benefit as a direct `pi.exec` lint call.
- **Panel's framing of #36's `agent_end` rework:** rejected. There is no bare `sendUserMessage` in `agent_end` and no separate bug there; keep only #36's `session_start` fix (idea A) and its counter (idea B).
- **Splitting the circuit breaker (#7) from #36's counter:** rejected as separate work. They are one mechanism; build them together as B.

---

## 4. Suggested worktree experiment plan

Five parallel worktrees off `main`, sequenced by dependency. Each must keep `bun test` green and `bunx tsc --noEmit` at exit 0 (per `AGENTS.md`).

| Worktree | Branch | Contents | Depends on | Gate to merge |
|---|---|---|---|---|
| wt-core | `feat/core-gate` | Harness mocks (`exec`/`abort`/`setThinkingLevel`) + A + B + C | none | All new + existing tests green; manual `pi -p --goal "…"` runs ≥1 turn; exec gate blocks on a deliberately failing fixture |
| wt-reflexion | `feat/reflexion-memory` | D (gate_rejections table, `<prior_attempts>` injection) | wt-core (C's rejection path) | Reflection synthesizer stubbed in tests; row + system-prompt assertions pass |
| wt-planning | `feat/planning-phase` | E (planningPhase, write-block, `goal_planning_complete`, schema column) | none | Block/unblock + planning-mode injection tests pass; verify real pi write-tool names |
| wt-lint-spike | `spike/inline-lint` | F + an empirical smoke test that confirms modified `tool_result` reaches the model | none | Smoke test proves injection reaches the model under the target provider *before* any merge decision |

**Execution order and decision points:**

1. **Land wt-core first.** It is the prerequisite for D and the only branch fixing the confirmed crash. Rebase the other branches onto it once the harness mocks are in, so they do not fork the harness.
2. **Run wt-planning and wt-lint-spike in parallel** with wt-core since they are independent, but treat wt-lint-spike strictly as a spike: its merge is conditional on the provider smoke test passing. If `tool_result` modifications are stripped, fall back to a `turn_end` context-channel injection or shelve F.
3. **Start wt-reflexion only after C merges**, since it consumes real rejection events.
4. **Validation per worktree:** unit tests are necessary but not the finish line. For wt-core, run an actual `pi -p --goal` against a tiny fixture repo (the existing `eval/` harness and `eval/tasks/slugify` seed are good scaffolding) and confirm: (a) at least one turn fires in headless mode, (b) a deliberately broken fixture makes the exec gate return `COMPLETION BLOCKED`, and (c) an always-red check trips `ctx.abort` at pass N instead of looping. Run `adversarial-review` on each diff before merge.

**Bottom line:** the de-risked, highest-value first PR is **wt-core (A+B+C)**. It fixes the only confirmed crash, adds the safety guard that every blocking idea depends on, and converts completion from self-narration to machine-checked exit codes — the three changes with the best impact-per-line in the pool. D, E, and F are real upside but each carries a dependency or an unverified assumption, so they belong in isolated follow-on worktrees, not the core.

Relevant files: `/Users/mish/.pi/agent/extensions/pi-goal-extension/index.ts`, `/Users/mish/.pi/agent/extensions/pi-goal-extension/index.test.ts`, `/Users/mish/.pi/agent/extensions/pi-goal-extension/goalManager.ts`, `/Users/mish/.pi/agent/extensions/pi-goal-extension/prompts.ts`, `/Users/mish/.pi/agent/extensions/pi-goal-extension/AGENTS.md`.