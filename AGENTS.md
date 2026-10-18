# AGENTS.md — pi-goal-extension

A `pi` coding-agent extension that drives a goal-oriented continuous loop: set a
goal, keep working until it is achieved, and gate "stopping" behind structured,
evidence-backed completion.

## Commands
- Install deps: `bun install`
- Typecheck: `bunx tsc --noEmit` (must exit 0)
- Test: `bun test` (Bun's built-in runner; tests live in `index.test.ts`)
- Run a single test: `bun test -t "<name substring>"`

## Critical facts / gotchas
- `sqlite3` has a Bun dependency patch in `patches/` that supplies an explicit
  `module_root` to `bindings`. Keep it when updating dependencies: compiled pi's
  Jiti loader otherwise makes stack-based discovery see `"[native code]"`.
  `loader.test.ts` checks the installed `pi` loader offline (skips if absent).
- **Package scope is `@earendil-works/*`, NOT `@mariozechner/*`.** Runtime value
  imports must use `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`.
  The installed packages are under `node_modules/@earendil-works/`. Importing the
  old `@mariozechner/*` scope makes 22/23 tests fail with "Cannot find module"
  (it only survives for `import type`, which is erased at compile time).
- `Type` and `StringEnum` come from `@earendil-works/pi-ai` (re-exported from
  `typebox` / its typebox-helpers). Tool parameter schemas use TypeBox.
- The test harness in `index.test.ts` hand-rolls a fake `pi` ExtensionAPI and
  imports `./index.ts?test=<unique>` per test to get a fresh module instance.
- **Never call `pi.sendUserMessage(text)` without a `deliverAs`.** In headless
  `pi -p` mode, `ctx.isIdle()` can report idle at `session_start` while a prompt
  is already being processed; a bare send then *async-rejects* with "Agent is
  already processing" (not synchronously catchable — see bindCore in
  pi-coding-agent's loader). Always pass `{ deliverAs: "followUp" }` (triggers a
  turn when idle, queues when busy) or `"steer"`.
- **The goal LOOP is interactive-only.** `pi -p` print mode runs exactly the
  positional prompt as one agent loop and exits; it does NOT pump
  extension-injected turns (neither the `session_start` goal injection nor the
  `agent_end` completion-gate follow-up fire as turns). So the continuous gate
  loop cannot be exercised end-to-end in `pi -p`. `tool_call`/`tool_result`
  hooks DO fire during that single turn, so scope/lint-style variants are
  e2e-testable; gate-loop behavior must be validated via the unit harness, which
  simulates the lifecycle events directly.

## Architecture (current)
- `index.ts` — extension entry: registers the `--goal` flag, `/goal` command,
  `goal_complete` tool (structured-evidence schema is the audit), `goal_task`
  tool (todo list), and lifecycle hooks.
- `goalManager.ts` — SQLite persistence (`~/.pi/agent/goals/goals.sqlite`),
  keyed by session id, with a serialized async operation queue.
- `prompts.ts` — the `<goal_state>` snapshot, mission prose, and
  completion-gate prose. Kept slim on purpose: the `goal_complete` schema is the
  audit, not an inlined checklist.
- `formatters.ts` — goal-text normalization, elapsed-duration formatting.

## Completion gate + safety (core variant)
- **Exec-verified completion gate:** `goal_complete` runs the project's
  verification commands via `pi.exec` and refuses completion on any non-zero
  exit (the failing output is returned + armed into the next gate turn).
  Commands are discovered in priority order: `.pi-goal.json` `{"validate":[...]}`
  → `package.json` scripts (`typecheck`/`test`/`lint`, run as their raw command).
  No commands found → completion proceeds but is flagged "not machine-verified".
  Opt out with `--goal-no-exec-gate`.
- **Gate-pass circuit breaker:** a counter increments on each `agent_end` gate
  pass and resets on genuine code progress (`edit`/`write` tool execution). At
  3 consecutive stuck passes it raises the thinking level once; at
  `--goal-max-gate-passes` (default 6) it aborts and marks the goal stopped, so
  an always-red exec gate or a text-only loop can't burn tokens forever.

## Scope enforcement (scope variant)
- **`goal_scope` tool** declares the file scope: `set` with `allow` and/or
  `deny` glob arrays, `list`, `clear`. Scope is in-memory (session-scoped;
  re-declare after a reload) and resets on goal replacement.
- A **`tool_call` hook hard-blocks** `edit`/`write` to out-of-scope paths via
  `{block, reason}`. deny takes precedence; a non-empty `allow` makes anything
  outside it out-of-scope. Paths are made cwd-relative and normalized (so `../`
  traversal can't slip past an allowlist). Reads/searches are never gated.
- The latest persisted goal snapshot carries `<goal_scope>`, including explicit
  unrestricted scope after clearing. Earlier snapshots remain historical.
  **Limitation:** bash-based writes (`echo >`, `tee`, `sed -i`) are NOT
  intercepted — scope is a drift guardrail, not a security sandbox.

## Loop mechanics (how the goal keeps the agent working)
1. `before_agent_start` returns a custom goal snapshot that Pi persists in the
   conversation. Mission, task state, scope and verifier feedback live together
   at the tail; the extension never overrides the system prompt.
2. `tool_result` publishes changed goal snapshots with `pi.sendMessage`, using
   steering delivery so they drain after the tool batch and before the next LLM
   call. Unchanged lists/no-ops do not publish redundant snapshots. Only the
   latest snapshot is authoritative; older messages are never moved or removed.
3. `agent_end` persists a completion-gate snapshot before sending a neutral
   `sendUserMessage(..., {deliverAs: "followUp"})` trigger. This works even when
   a busy runtime queues the continuation without another `before_agent_start`.
   The custom message reaches cursor-agent even when synthetic user text does
   not. The agent must keep working or call `goal_complete` with evidence.
4. `session_compact` restores the authoritative snapshot after history is
   compacted, including automatic retries without another run-start event.

**Cache invariant:** do not reintroduce temporary goal messages in `context` or
rewrite the system prompt for active/inactive goals. Each normal request must
preserve the preceding provider-visible transcript as an exact prefix. Moving
an ephemeral reminder from before the previous assistant response to after its
new tool results breaks that invariant and can cause a full cache rebase.
Regression tests and limitations: `docs/CACHE.md`.

## Useful extension API surface (from @earendil-works/pi-coding-agent)
- Events can **block** (`tool_call` → `{block, reason}`) and **modify**
  (`tool_result`, `message_end`, `context`). Also: `turn_start/end`,
  `tool_execution_*`, `before/after_provider_*`, `session_*`, `resources_discover`
  (contribute skill/prompt paths).
- `pi.exec(cmd, args, opts)` runs shell commands (enables test/lint pressure).
- `ctx.getContextUsage()` gives token usage; `ctx.compact()` triggers compaction;
  `ctx.model` / `pi.setModel` / `pi.setThinkingLevel` adjust the model.
- `pi.appendEntry` persists non-LLM state; `pi.events` is a shared bus.
- Command handlers get `newSession`/`fork`/`navigateTree`/`switchSession`.

## Optional verifier completion gate

The separate sibling `../verifier` extension supplies an independent read-only
completion reviewer over `pi.events` (`verification.ts` contains the protocol).
The goal extension has no import of the verifier implementation and retains
standalone behavior when the verifier is absent or disabled.

`/verifier on|off` follows advisor's enabled-on-load, runtime-only pattern. Only
`VERIFIER_PROVIDER` and `VERIFIER_MODEL_ID` configure its model, with no fallback.
`goal_task check` waits for approval before saving. Rejection keeps the task open,
blocks remaining sibling tool calls in that batch, and keeps corrective feedback
in context until the failed task passes (or the user disables verification).
`goal_complete` retains the exec gate, then verifies all unchecked tasks and the
whole goal before its final save. Completion tools are sequential so the lead
cannot execute later sibling actions while review is pending.

Evidence, limitations, and exact commands: `docs/VERIFIER.md`. Focused runtime
checks: `cd ../verifier && pnpm run check`; original goal regressions remain
`bun test index.test.ts`. No changes to SQLite schema or goal contract format.
