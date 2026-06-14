## 1. Workspace Status and Alias Resolution

- [ ] 1.1 Add shared Git status helpers for branch/head/detached state, tracking branch, numeric ahead/behind, dirty path counts, and in-progress Git operation detection.
- [ ] 1.2 Add root gitlink state helpers that read HEAD, index, and working tree pointer OIDs and classify `moved`, `staged`, `split`, `missing`, and `conflict` states.
- [ ] 1.3 Add `--json` support to `oms status` that prints only two-space pretty JSON on stdout with `schemaVersion`, `toolVersion`, `workspaceRoot`, `currentAlias`, `root`, `repos`, `errors`, and repo entries that use `configured` for `oms.yaml` membership.
- [ ] 1.4 Preserve JSON shape when a repo status read fails by emitting repo-local `error`, top-level `errors`, `null` unknown scalar fields, safe default structured fields, and a non-zero exit code.
- [ ] 1.5 Add `missing` and `conflict` pin support to both JSON status and the human-readable status table.
- [ ] 1.6 Add path-segment based current alias inference for configured `oms/<alias>/` subtrees, including uninitialized aliases.
- [ ] 1.7 Add command-specific alias resolution for `commit` and `record`: explicit alias, cwd inference, interactive valid-candidate selection, and non-interactive alias-required failure.
- [ ] 1.8 Add CLI tests for status JSON shape, pretty JSON-only stdout, `configured` semantics, root/submodule/null `currentAlias`, schema compatibility expectations, detached state, missing tracking branch, numeric ahead/behind, `missing` never-synced repos, `uninit` recorded-but-uninitialized repos, dirty counts, root/submodule change separation, alias-filtered repos and pointer arrays, root pointer `moved/staged/split/conflict`, `missing` and `conflict` pins, unknown alias failure without JSON, and partial repo errors.
- [ ] 1.9 Add CLI tests for path-segment alias inference, uninitialized alias precondition failure, interactive zero/one/multiple candidate behavior, and non-interactive alias omission failure.

## 2. Scoped Commit Command

- [ ] 2.1 Add `oms commit [alias] -m <message...>` command parsing with repeated `-m` support.
- [ ] 2.2 Require `-m` only when a submodule source commit is needed; reject dirty submodule commits without `-m` without opening an editor, but allow complete no-op cases without `-m`.
- [ ] 2.3 Validate submodule commit preconditions: initialized repo, non-detached HEAD, and no merge/rebase/cherry-pick/revert/bisect or similar Git operation in progress.
- [ ] 2.4 Implement staged-first submodule-only commit behavior: commit existing staged submodule changes without `git add -A`; when nothing is staged, run `git add -A` and commit all submodule changes.
- [ ] 2.5 Warn when staged submodule changes are committed while unstaged or untracked submodule changes remain.
- [ ] 2.6 Print submodule short commit SHA after successful commits and print the correct root follow-up hint: `oms record <alias>` for existing moved gitlinks or `oms sync <alias> --commit` for pending add topology.
- [ ] 2.7 Implement no-op handling for no submodule changes with exit code 0, including record hints for existing moved pointers and topology commit hints for missing recorded gitlinks.
- [ ] 2.8 Ensure `oms commit` never stages or commits root gitlinks and never suggests `oms record <alias>` when `record` would reject a missing recorded gitlink.
- [ ] 2.9 Add CLI tests for staged-first commits, all-change fallback staging, unstaged/untracked remaining warning, untracked files, repeated `-m`, missing `-m` with dirty submodule failure, no-op without `-m`, detached HEAD rejection, merge/rebase/cherry-pick/revert/bisect rejection, root index/history untouched behavior, record hint output, and topology hint output.

## 3. Root Pointer Record Command

- [ ] 3.1 Add `oms record [alias]` command parsing with alias resolution.
- [ ] 3.2 Implement pointer commit message generation as `chore(oms): update <alias> submodule to <short-sha>` using the submodule's `git rev-parse --short HEAD` output.
- [ ] 3.3 Add root record precondition checks for detached root HEAD, merge/rebase/cherry-pick/revert/bisect root Git operations, missing recorded gitlink with pending-add `oms sync <alias> --commit` guidance when applicable, conflicted gitlink, pending submodule removal (root HEAD has a gitlink but the working tree path has been removed) with `oms unsync <alias> --commit` guidance, unrelated staged paths, staged child paths under `oms/<alias>/`, and selected pointer split state.
- [ ] 3.4 Use NUL-delimited staged path reads for root repository index safety checks.
- [ ] 3.5 Stage only the selected `oms/<alias>` gitlink and create a path-limited root repository commit for that path.
- [ ] 3.6 Allow unrelated unstaged root repository changes and allow an already staged selected gitlink when it matches the working tree pointer.
- [ ] 3.7 Warn but proceed when the selected submodule has uncommitted source changes, recording only the current HEAD pointer.
- [ ] 3.8 Implement record no-op exit 0 when there is no pointer movement.
- [ ] 3.9 Print root commit short SHA and commit message after successful record commits.
- [ ] 3.10 Add CLI tests for moved pointer record, absent pointer no-op, unrelated staged root repository rejection, unrelated unstaged root repository allowance, selected staged gitlink allowance, other alias staged gitlink rejection, selected pointer split rejection, missing gitlink rejection with topology guidance when applicable, conflicted gitlink rejection, pending removal rejection with `oms unsync <alias> --commit` guidance, detached root rejection, root operation-in-progress rejection for merge/rebase/cherry-pick/revert/bisect, dirty submodule warning, and path-limited commit behavior.

## 4. Root-Safe Sync, Pull, Push, and Removed Commit Option

- [ ] 4.1 Change `oms sync` and `oms unsync` to leave root topology changes in the working tree without leaving automatically staged `.gitmodules` or selected `oms/<alias>` root index entries when no topology commit is created.
- [ ] 4.2 Preserve unrelated staged root changes when clearing automatic sync/unsync staging.
- [ ] 4.3 Add interactive topology commit prompts after successful sync/unsync when `--commit` is absent.
- [ ] 4.4 Add explicit `oms sync --commit` and `oms unsync --commit` support that creates topology commits without prompting in both interactive and non-interactive environments, including pending topology changes from previous no-commit runs with add/removal detection based on root HEAD, working tree submodule path, and `.gitmodules` entries; reject partial removal topology unless the current unsync invocation completes the matching cleanup first.
- [ ] 4.5 Implement automatic topology commit messages for single-alias and multi-alias sync/unsync.
- [ ] 4.6 Reject topology commits when unrelated root paths are already staged.
- [ ] 4.7 For multi-alias sync/unsync, show a single topology commit prompt or create a single `--commit` topology commit only when all requested aliases succeed; otherwise unstage successful topology changes and summarize manual follow-up.
- [ ] 4.8 Change `oms pull` and `oms push` to synchronize only submodule branches without staging or committing root gitlinks, while allowing the root working tree to show visible gitlink movement.
- [ ] 4.9 Change `oms push --commit` to fail before pushing as an unsupported option with `oms push <alias>` plus `oms record <alias>` migration guidance.
- [ ] 4.10 Reject `oms push --record` as an unknown or unsupported option.
- [ ] 4.11 Reject pull and push from detached submodule HEAD with guidance to run `oms switch <alias> <branch>`.
- [ ] 4.12 Reject pull when the submodule has uncommitted source changes; warn but proceed when pushing a dirty submodule because only the current HEAD is pushed.
- [ ] 4.13 Print `oms record <alias>` hints after successful pull or push when an existing recorded root pointer is moved, and print topology commit hints when the recorded gitlink is missing but pending add topology exists.
- [ ] 4.14 Process multi-alias `pull` and `push` independently, continue after per-alias failures, summarize per-alias results, and exit non-zero if any alias failed.
- [ ] 4.15 Update existing `push --commit` tests to expect no submodule push, unsupported-option guidance with `oms record <alias>`, a usage/config error exit, and no root pointer commit.
- [ ] 4.16 Add CLI tests for sync/unsync path-limited unstage behavior, topology commit prompts, explicit sync/unsync `--commit`, rerun `--commit` against pending topology changes, partial removal topology rejection, single/multi alias topology commit messages, no topology prompt/commit on partial multi-alias failures, unrelated staged root rejection for topology commits, preservation of unrelated staged root changes when unstage applies, pull-only and push-only behavior, no root gitlink staging, record hint output, topology hint output, unsupported `--record`, unsupported `--commit` before push side effects, detached pull/push rejection, dirty pull rejection, dirty submodule push warning, and multi-alias partial failures.

## 5. Agent Instruction Commands

- [ ] 5.1 Add reusable managed-block helpers for detecting missing, valid, and malformed `<!-- OMS START -->` / `<!-- OMS END -->` marker states.
- [ ] 5.2 Add atomic pre-write validation for all selected target files before install or uninstall writes.
- [ ] 5.3 Define concise OMS agent instruction block content with durable rules and `oms --help` / `oms <command> --help` guidance.
- [ ] 5.4 Add `oms agent install [--target agents|claude|both]` with interactive target selection and non-interactive target-required failure.
- [ ] 5.5 Implement install behavior for creating `oms/`, creating missing files, appending after two blank lines, replacing exactly one managed block, preserving outside content, normalizing one trailing newline, and not staging files.
- [ ] 5.6 Add `oms agent uninstall [--target agents|claude|both]` with matching target selection rules.
- [ ] 5.7 Implement uninstall behavior for removing exactly one managed block, deleting files that become empty or whitespace-only, and no-op success for missing files or missing blocks.
- [ ] 5.8 Fail install and uninstall without modifications when selected files contain malformed marker states, including duplicate complete blocks.
- [ ] 5.9 Add CLI tests for install target selection, non-interactive target requirement, create/append/replace behavior, trailing newline normalization, no Git staging, uninstall removal, uninstall empty-file deletion, no-op uninstall, malformed marker rejection, duplicate block rejection, and multi-target atomic validation.

## 6. Help Documentation

- [ ] 6.1 Update help output for `status --json`, `sync`, `unsync`, `commit`, `record`, `pull`, `push`, and `agent install/uninstall` so each new or changed command explains purpose, scope, and at least one example.
- [ ] 6.2 Add CLI tests for updated help text boundary descriptions.

## 7. Documentation and Verification

- [ ] 7.1 Update README examples and command reference to document `oms status --json`, `oms commit`, `oms record`, `oms pull`, `oms push`, and `oms agent`.
- [ ] 7.2 Update README text to document `oms push --commit` as unsupported in favor of explicit `oms push <alias>` followed by `oms record <alias>`.
- [ ] 7.3 Document default sync/unsync unstage behavior, sync/unsync topology commit prompts and `--commit`, that `oms pull` and `oms push` do not stage or commit root gitlinks, and that `oms record <alias>` is required to commit existing root pointer updates.
- [ ] 7.4 Add a README migration or behavior changes section that calls out `push --commit` removal, pull/push no longer staging root gitlinks, and sync/unsync default unstage behavior with before/after examples.
- [ ] 7.5 Document the concise managed instruction files under `oms/AGENTS.md` and `oms/CLAUDE.md` as root-repository files, not submodule files.
- [ ] 7.6 Run the full test suite with `npm test`.
- [ ] 7.7 Review command help output manually for the new commands and options.
