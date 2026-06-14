## 1. Help text

- [ ] 1.1 Expand the `statusHelp` constant in `scripts/oms.ts` to document the `schemaVersion` 1 `status --json` contract: list the seven top-level keys (`schemaVersion`, `toolVersion`, `workspaceRoot`, `currentAlias`, `root`, `repos`, `errors`), call out `root.submodulePointers` with its `moved`/`staged`/`split`/`conflict` arrays, and summarize the per-repo `repos[]` entry, keeping it concise (no exhaustive nested-field dump).
- [ ] 1.2 Fix the existing summary line `(schemaVersion, root, repos, pointers)`: replace the bare `pointers` with `root.submodulePointers` and add the missing top-level keys.

## 2. Code comment

- [ ] 2.1 Repoint the `JsonRepoStatus` comment in `scripts/oms.ts` ("See design.md for the stable schemaVersion 1 contract") at a live source — the `ai-submodule-workflow` spec and/or `oms status --help` — since the referenced `design.md` is now archived.

## 3. Verification

- [ ] 3.1 Add a CLI test asserting `oms status --help` names the seven top-level keys and refers to `root.submodulePointers` (not a top-level `pointers`).
- [ ] 3.2 Run the full test suite with `npm test`.
