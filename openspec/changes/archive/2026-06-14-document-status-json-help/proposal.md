## Why

The `add-oms-workspace-skill` change publishes skills that defer `oms status --json` field semantics to `oms status --help`, chosen because that help text ships with the installed CLI and therefore always matches the `schemaVersion` the CLI emits — eliminating the skill-versus-CLI version skew a GitHub-hosted doc would reintroduce. But today `oms status --help` prints only a one-line summary, `(schemaVersion, root, repos, pointers)`, which is thin and partly wrong: the top-level keys are actually `schemaVersion`, `toolVersion`, `workspaceRoot`, `currentAlias`, `root`, `repos`, and `errors`, and the pointer arrays live at `root.submodulePointers`, not a top-level `pointers`. A `scripts/oms.ts` comment also points the `schemaVersion` 1 contract at a `design.md` that has since been archived. An agent that follows the skills to `oms status --help` lands on a partly incorrect, non-authoritative summary.

## What Changes

- Expand the `oms status --help` text (`statusHelp` in `scripts/oms.ts`) into an accurate, concise reference for the `schemaVersion` 1 `status --json` payload: the seven top-level keys, `root.submodulePointers` and its `moved`/`staged`/`split`/`conflict` arrays, and a summary of the per-repo `repos[]` entry — without an exhaustive nested-field dump.
- Correct the summary: replace the bare `pointers` with `root.submodulePointers` and add the missing top-level keys (`toolVersion`, `workspaceRoot`, `currentAlias`, `errors`).
- Repoint the `scripts/oms.ts` `schemaVersion` 1 contract comment away from the archived `design.md` to a live source (the `ai-submodule-workflow` spec and `oms status --help`).
- Add a test asserting `oms status --help` names the corrected top-level keys and `root.submodulePointers`, guarding the `pointers` regression.

## Capabilities

### Modified Capabilities
- `ai-submodule-workflow`: Adds a requirement that `oms status --help` documents the `schemaVersion` 1 field contract accurately, so it is the authoritative, version-matched reference other artifacts (the `oms` workspace skills) defer to.

## Impact

- `scripts/oms.ts`: the `statusHelp` constant (expanded, `pointers` label corrected) and the `JsonRepoStatus` schema comment (repointed off the archived `design.md`).
- `tests/cli.test.js`: a check that `oms status --help` lists the corrected top-level keys and `root.submodulePointers`.
- Unblocks `add-oms-workspace-skill`, whose skills defer field semantics to `oms status --help`; that change's task 0.1 gates its apply on this change landing.
- The `oms status --json` payload and its `schemaVersion` are unchanged — only the documentation surface changes.
