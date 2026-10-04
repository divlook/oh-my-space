# Tasks

Keep the build and existing tests passing after each implementation step.

## 1. Scoped command execution

- [x] 1.1 Implement the execution entry point in `scripts/lib/exec.ts`. Reuse read-only workspace checks and repository selection. Add integration tests for target eligibility and preserved Git state. Check completion with `npm run build` and `npm run test:integration`.
  - Reuse workspace loading and the existing refusal for invocation from a managed tree.
  - Do not invoke preparation that changes repository state.
  - Cover initialized targets with dirty files or detached HEAD.
  - Cover unavailable targets and foreign directories at target paths.
  - Check that OMS preserves Git state in the root and source repositories.

- [x] 1.2 Implement sequential direct execution with asynchronous child processes. Add real-child tests for order, results, and preserved effects. Check completion with `npm run test:inventory`, `npm run build`, and the affected test layers.
  - Inherit the caller's environment and streams.
  - Identify aliases in output headers.
  - Report detailed results for each alias.
  - Return the specified OMS exit code.
  - Prove execution order with real children.
  - Prove continuation after a child exits non-zero.
  - Prove continuation after spawn failures and target failures.
  - Check that OMS preserves files that a failed child changes.
  - Register tests in `tests/test-inventory.json`.

- [x] 1.3 Register `exec` in `scripts/oms.ts`. Separate child arguments before Commander parses OMS arguments. Add behavioral tests and command help. Check completion with the built CLI, `npm run build`, and the affected tests.
  - Add `exec` to the known command set.
  - Retain the raw arguments after the first `--` without changing them.
  - Add command help in `scripts/lib/help.ts`.
  - Cover missing separators and missing executables.
  - Cover empty arguments and literal arguments.
  - Cover child flags and additional separators.
  - Cover duplicate explicit aliases and their execution order.
  - Cover `--all` and unknown aliases.
  - Cover omitted selection in non-interactive sessions.
  - Exercise the built CLI with a real Node child that reports its working directory and arguments.

- [x] 1.4 Document the interface and execution scope. Add an English Changeset. Check documented examples and `node dist/oms.js exec --help` against the built CLI.
  - Update `docs/commands.md` and `docs/how-oms-works.md`.
  - Explain explicit shell invocation.
  - Explain continuation after target failure and the OMS exit codes.
  - Explain that OMS does not prepare targets automatically.
  - Explain sequential stdin consumption and child side effects.
  - Do not add tests that assert documentation wording.

## 2. Whole-invocation interruption

- [x] 2.1 Implement SIGINT handling and active-child tracking. Add black-box tests against the production bundle. Check completion with `npm run build` and the affected black-box owner.
  - Install temporary signal handlers.
  - Set the interruption state before forwarding SIGINT.
  - Recognize SIGINT when the active child receives it first.
  - Resolve each child's completion once.
  - Stop scheduling new children after interruption.
  - Wait for the active child to close.
  - Remove temporary handlers.
  - Report unstarted aliases as not run.
  - Synchronize tests on explicit child readiness.
  - Prove exit 130 and no execution in later targets.
  - Prove continuation after a child receives a signal other than SIGINT.
  - Update `tests/test-inventory.json`.

- [x] 2.2 Document Ctrl+C behavior in command help and documentation. Check the documented behavior with a manual interruption of a ready child.
  - Explain that OMS preserves completed effects.
  - Explain the limit for children that ignore SIGINT or intentionally detach descendants.
  - Keep the build and interruption tests passing.

## 3. Integrated acceptance

- [x] 3.1 Exercise the built CLI in a disposable workspace with two repositories. Check literal arguments, live output, results, and unchanged Git state. Remove temporary material after the checks.
  - Execute `node dist/oms.js exec api web -- <command> [args...]` with real Node commands.
  - Exercise `--all` separately.
  - Check the working directory for each child.
  - Check live stdout and stderr.
  - Check the summary for mixed success and failure.
  - Check OMS exit code 2.
  - Check unchanged registration, index, and HEAD when children perform only read operations.
  - Check that OMS does not initialize unavailable targets.
  - Check that OMS still executes commands in healthy targets.

- [x] 3.2 Check integration with `npm test` and `openspec validate add-exec-command --strict`. Check that existing selection and preparation tests still pass.
  - Check that the test inventory remains within the limit for each owner.
  - Check that the implementation adds no dependencies or manifest fields.
