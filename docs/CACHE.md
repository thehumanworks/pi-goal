# Cache-friendly goal snapshots

## Cause

The old `context` handler appended temporary goal state, scope and verifier
messages on every LLM call. These messages were not part of session history.
Consequently, even unchanged reminder text moved relative to assistant/tool
messages on the next request:

```text
Request 1: history + temporary goal state
Request 2: history + assistant/tool results + temporary goal state
```

Request 1 was no longer a prefix of request 2. The one-shot completion gate also
disappeared from later requests. Providers that synchronize an append-only
transcript (notably cursor-agent) can treat these changes as a history rewrite,
checkpoint the conversation, and lose the cached prefix. Regenerating timestamps
was not the main issue: message ordering changed even with identical text.

The extension also replaced the system prompt while a goal was active. Changing
that leading prompt when starting/completing goals could invalidate the entire
cached conversation independently of the temporary reminders.

## Delivery now

- `before_agent_start` returns one custom message containing the mission, goal
  tasks, scope and verifier feedback. Pi persists it in the conversation; the
  extension does not override `systemPrompt`.
- The `tool_result` handler publishes changed snapshots after `goal_task`,
  `goal_scope`, and `goal_complete`. `pi.sendMessage` uses steering delivery,
  drained after tool results and before the next LLM call. Unchanged lists,
  no-ops and validation errors do not repeat the snapshot.
- `agent_end` persists the gate body as a custom message **before** sending the
  existing follow-up user trigger. It therefore reaches the model even when
  the runtime is busy and the queued continuation does not fire run-start
  hooks again. The body is not dependent on synthetic user-message text.
- Completion and circuit-breaker stops append an explicit inactive snapshot.
  Scope clearing and verifier resolution/disabling append explicit clearing
  information. Earlier instructions remain historical, not currently active.
- Snapshot details are cloned, so later task mutations cannot change them.
- `session_compact` restores the latest state after compaction, including
  automatic continuations. Reload/resume restores it at the next run start.

```text
Request 1: history + persisted snapshot 0
Request 2: history + persisted snapshot 0 + assistant/tool results
Request 3: history + persisted snapshot 0 + assistant/tool results
           + persisted snapshot 1 (only if state changed)
```

Do not delete obsolete snapshots from `context`: that would rewrite history
again. The latest snapshot explicitly supersedes earlier goal, task, scope,
verifier and gate instructions. Normal Pi compaction bounds history growth.

Goal replacement also cancels a pending old-goal continuation before awaiting
SQLite creation, preventing a stale gate from firing during that wait.

## Regression checks

Run `bun test` and `bunx tsc --noEmit`. The `index.test.ts` suite
`append-only goal context (prompt-cache regression)` exercises:

- consecutive ordinary write/read/edit exchanges and repeated context reads;
- task add/check/uncheck and scope set/clear;
- suppression of unchanged snapshots;
- completion gates and later user runs;
- completion followed by goal replacement;
- verifier rejection, approval, and disabling;
- failed exec verification followed by a successful retry;
- compaction followed by continuation without another run-start hook.

The harness models persisted run-start messages and post-tool steering delivery,
then uses Pi's actual `convertToLlm` conversion. Prefix checks compare the entire
previous provider-visible message array against the start of the next request,
not just the goal text or the number of reminders. Historical snapshot details
are checked separately for mutation. Existing lifecycle, SQLite, exec-gate,
scope, headless-delivery and installed-loader tests remain in the full suite.

On Nix, the native SQLite dependency may require `libstdc++.so.6` on
`LD_LIBRARY_PATH` when running Bun directly outside the host Pi wrapper.

## Rollout and limits

Use `/reload` (or restart Pi) to load the changed extension. The transition from
the old prompt layout may itself require one cache rebase; subsequent normal
calls should preserve this extension's prefix.

These tests are offline transcript-invariant checks, not measurements of live
provider billing. Cache expiry, model/provider switches, deliberate compaction,
tool-loadout changes, and other extensions rewriting context can still cause
misses. The fix removes pi-goal's per-call transcript rewriting; it does not
promise that a provider will always report a cache hit.
