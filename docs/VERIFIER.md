# Optional task-completion verifier — implementation and evidence

## Architecture decision

Use a **separate verifier extension**, discovered only when loaded and enabled, to keep model-backed verification optional and leave both the goal's standalone operation and the advisor's existing behavior intact.

Location: `/home/tomas/.pi/agent/extensions/verifier`.
Goal integration: `/home/tomas/.pi/agent/extensions/goal`.

## Landed changes

- `goal/index.ts`: await optional reviews before `goal_task check` and before final `goal_complete` mutation; sequential completion tools; rejected-batch blocking; corrective context and error tool results; prevention of completing other tasks/the goal while a rejected task is unresolved; pass observed existing validation results to the verifier; ignore stale results after goal/session replacement. Await database close at shutdown.
- `goal/verification.ts`: small typed extension protocol over `pi.events`, with synchronous service discovery and an explicitly awaited asynchronous review. The goal has no runtime import of the verifier implementation.
- `goal/index.test.ts`: supply the existing fake API with the documented event-bus surface. All original test assertions remain intact.
- `verifier/index.ts`: independent read-only verifier agent, `VERIFIER_PROVIDER` / `VERIFIER_MODEL_ID` model selection, strict pass/feedback verdict handling, and always-available `/verifier on|off` command.
- `verifier/tests/runtime.test.ts`: focused integration contract exercised through real Pi loading, tools, commands, HTTP/SSE transport, and SQLite state.
- `verifier/package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `.gitignore`: reproducible development/runtime dependencies and checks. No new user-facing runtime config file.
- Goal `.gitignore`: retain the two focused test-evidence logs in version control.
- `verifier/README.md`, this report, captured logs, and goal `AGENTS.md`: usage, architecture, boundaries, and verification evidence.

The advisor's implementation and settings were not changed. The original goal tool schemas, SQLite schema, scope policy, exec-gate command discovery/flag, and goal-loop circuit breaker were retained.

## Contract and behavior

The existing verification contract comes from the user's goal/task requirements and session history, `goal_complete`'s five evidence-field descriptions, and the existing `.pi-goal.json` `validate` commands (otherwise `package.json` typecheck/test/lint script discovery). No new contract format or config file was introduced. Task reviews apply task-relevant criteria; whole-goal reviews apply the complete goal contract.

The verifier uses Pi's existing authenticated model registry and read-only `read`, `grep`, `find`, `ls` tools. Completion claims alone are not proof: its instructions require comparison with actual artifacts and observed results. A fresh isolated model/tool loop is used for every review; no goal/advisor tools are made available to it.

A failed task check does not advance task state. Remaining calls in that assistant message are blocked, and the next lead turn receives concrete corrective feedback. Remediation remains possible; later completion claims cannot bypass the failed task. `goal_complete` reviews every task it would implicitly mark complete plus the whole goal, and only then writes the final state.

Absent or disabled verifier: original goal behavior, no verifier request. Enabled verifier: missing configuration, unknown models, missing authentication, provider errors, unusable verdicts, and cancellation do not authorize completion.

## Command/configuration decisions

- `/verifier on` and `/verifier off`, matching the advisor's raw-argument on/off command pattern; both remain available in either state.
- Enabled on load and runtime-only toggling, matching the existing advisor lifecycle. No additional persistence rule, picker, selection command, or toggle setting.
- Only `VERIFIER_PROVIDER` and `VERIFIER_MODEL_ID`; no model/provider default and no borrowing advisor/lead configuration.
- Existing Pi provider credentials are used. No credentials, real Pi settings, or environment-helper files were changed.
- Both variables were **unset in the command shell inspected for this work**. A separately launched Pi process may have different environment values. Live verification requires setting these in Pi's environment; no unspecified model was selected on the user's behalf.

## Verification results

Evidence captured on 2026-09-14. Runtime: Pi **0.85.1**, Node **v26.8.1**, Bun **1.4.2**, pnpm **12.4.1**. TypeScript **5.9.3**.
The goal's existing dependency versions remain **0.74.2**; integration is additionally exercised against the actual current **0.85.1** runtime. Verifier dependencies are **0.85.1**.

| Check | Result |
| --- | --- |
| From goal: `../advisor/node_modules/.bin/tsc --noEmit` | Passed, exit 0; uses the already-installed compiler, no goal dependency upgrade. |
| From goal: `bun test index.test.ts` | **39 passed, 0 failed, 191 assertions**. |
| From verifier: `pnpm run check` | Strict typecheck passed; **25 passed, 0 failed, 141 assertions**, exit 0. |
| Goal `git diff --check` | Passed. |

Combined: **64 tests passed, 0 failed, 332 assertions**. Captured outputs: [goal regressions](verifier-goal-tests.log), [verifier runtime checks](verifier-runtime-tests.log). No broader suite was run after these focused checks passed.

### Definition-of-done evidence

| Required outcome | Observable check |
| --- | --- |
| Verifier runs at task completion before lead continuation | A deferred verifier HTTP response holds `goal_task check` open. SQLite remains unchecked, a queued sibling write has not executed, and only one lead request exists. Releasing approval allows the save and sibling action. Observed request order: lead → verifier read request → verifier verdict request → lead. |
| Named environment configuration | Separate fixture model/provider and distinct verifier authentication header observed on actual requests; lead model remains unchanged. Missing/blank env, unknown provider/model, and unauthenticated provider reject without fallback. |
| Slash-command on/off available in both states | Repeated off/off/on/on/off commands return displayed status events with no model request. Active goal tools and settings files remain unchanged. Disabled verifier allows ordinary completion even with invalid verifier env. |
| Validate the existing verification contract | Actual outgoing payload includes literal goal/task requirements, original user contract, all five existing evidence descriptions, and project validation commands. The verifier calls the actual Pi read tool; its next request contains the real file contents. Final goal reviews additionally receive executed command exit codes/stdout/stderr and the submitted evidence. Fixture verdicts depend on the read artifact. |
| Rejection prevents moving ahead and supplies recovery actions | A broken artifact causes an error result with concrete correction, leaves timestamps/state incomplete, prevents the queued sibling write, and injects `verification_block` into the next lead request. Other task checks and final completion do not trigger a bypass review or mark progress. A subsequent real write fixes the artifact; rechecking passes and later task completion is allowed. |
| Verifier is optional, not bundled into goal | Goal-only load passes task and goal completion with verifier env absent and no verifier request. Verifier-only load supports toggling without goal tools. Goal imports only its protocol, never verifier implementation. |
| All completion paths covered | Bulk completion reviews each unchecked task plus the whole goal. A rejection during that sequence leaves all pending tasks and the goal incomplete. A no-task goal still gets reviewed. The original red executable check rejects before model verification. |

Additional bounded checks cover malformed/empty/truncated verdicts, HTTP 401, cancelling an in-flight review, disabling after rejection, and reload subscription/lifecycle behavior.

### Fixture corrections during development

The first typecheck exposed a library-target mismatch in the test's use of `findLastIndex`; the fixture now uses an equivalent typed reduction. Initial runtime failures exposed the pre-existing goal entry's module-level `HOME` database-path capture: loading its same cached module across artificial fixture HOME changes re-used the first path. Each fixture now loads a byte-identical isolated copy of the goal runtime files, with original dependencies, rather than changing production database-path behavior. These were test isolation corrections; no acceptance assertions were removed.

The fixture handles only the goal extension's existing neutral idle-loop trigger to keep each explicit scenario bounded. It does not intercept completion tools or verifier requests. The independent original goal lifecycle tests exercise the autonomous gate loop.

## Remaining uncertainty and out-of-scope findings

- External vendor access, account entitlements, OAuth refresh, and the semantic reliability of a real verifier model are **unverified**. Runtime tests use deterministic local model responses with synthetic credentials, not a live vendor model.
- Displayed command status and tool feedback are checked through Pi events and session history, not a manual TUI visual inspection.
- The existing goal module captures its HOME-derived DB path at module import; changing HOME within one process is not supported by that code. The fixture isolates this; no unrelated storage-path refactor was made.
- The existing goal-loop hard-stop/circuit-breaker behavior is unchanged; this change does not redesign task scheduling or introduce a new contract format.

Work is left on disk without staging/committing. The original goal source files were backed up at `/tmp/pi-goal-verifier-before-pmy06x2k`.

## API references

Implementation checked against the installed Pi `docs/extensions.md`, event-bus example and types, public model-registry APIs, read-only tool factories, and the sequential tool execution path. Public documentation: https://pi.dev/docs/latest/extensions . No undocumented flag parser, subagent API, or asynchronous event-bus return value was assumed.

## Verified source SHA-256

```text
5953ca026572fbefb6cbcdce169383398b483ac300f5659e20e24e1c4cc35901  goal/index.ts
d0ea1fcae609b1bfe8a206c8b663278d2261f363c8bed934150031fbeaf06256  goal/index.test.ts
28572a81c0bb319c32b11dd3395474ffe6c7d3142213aca30d90ce0c4d29c408  goal/verification.ts
394234d4cb26271c6d0ba60a6466f0c07e61bf0f9dd657c6068a45344b35b7a2  verifier/index.ts
968e7507c3de2eee70c0092c04ef674a5ea50af3952da000fedcaebbf754568b  verifier/tests/runtime.test.ts
752bb2a9f7d21a1d4f992b274a0c9520c39dbefa8126ae31426e2bcf77f1c5cc  verifier/package.json
0356d4ee239ae6cd8f79d5c7fa9a96c83caf153c50e9c8fe8653d747406dd1b9  verifier/pnpm-lock.yaml
fddca08fe0ee65b3566bdc76e30bd363edfd8e7d15f045936b703424aa686223  verifier/tsconfig.json
```
