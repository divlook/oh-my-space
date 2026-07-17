## 1. Workspace Context Primitives

- [x] 1.1 Replace existence-only workspace lookup with a structured nearest-manifest resolver that distinguishes missing, regular-file, and invalid non-file candidates and never falls back past an encountered candidate.
- [x] 1.2 Add a Git top-level inspection helper and canonical path identity comparison that distinguishes no work tree, matching root, mismatched root, and indeterminate inspection.
- [x] 1.3 Keep current configured-submodule alias inference separate from workspace discovery and verify that explicit command aliases retain precedence.

## 2. Command Preflights

- [x] 2.1 Update the shared submodule-loading preflight to require canonical equality between the manifest directory and root Git top-level before root submodule inspection or mutation.
- [x] 2.2 Apply the same precondition to mutating `oms sync` while preserving manifest-only `oms sync --list` outside Git.
- [x] 2.3 Update `oms doctor` to diagnose a nested manifest/root Git mismatch directly and avoid reporting the manifest directory as a valid root repository.
- [x] 2.4 Preflight `oms init` before all writes so Git-top-level and non-Git targets still scaffold, while a child of an existing Git work tree fails even with `--force`.
- [x] 2.5 Standardize actionable errors for missing manifests, non-file manifest candidates, Git-root mismatch, and indeterminate canonical identity without changing the status JSON schema.

## 3. Regression Coverage

- [x] 3.1 Add CLI tests proving nearest nested manifest selection; acceptance of an `oms.yaml` symbolic link to a regular file; and fail-closed behavior for non-file, broken-link, non-file-link-target, and invalid nearest candidates without ancestor fallback.
- [x] 3.2 Add tests proving a nested manifest below a Git top-level is rejected before `.gitmodules`, the root index, `oms/`, or `oms.yaml` changes, while canonical-equivalent symlink paths are accepted; cover each command routed through the shared submodule preflight.
- [x] 3.3 Add tests proving commands that require submodule state fail without side effects when no Git root exists or Git inspection or canonicalization leaves root identity indeterminate.
- [x] 3.4 Add `oms init` tests for Git-top-level success, non-Git success, nested-root rejection, `--force` rejection, indeterminate target identity, and absence of preflight side effects.
- [x] 3.5 Preserve regression coverage for execution inside configured and uninitialized `oms/<alias>/` paths, current alias reporting, explicit alias precedence, and `sync --list` without Git.
- [x] 3.6 Verify that workspace path canonicalization does not change the existing `status --json` schema or emitted path representation.

## 4. Documentation And Verification

- [x] 4.1 Update README command-location guidance and relevant help text to explain nearest-manifest discovery, configured-submodule context, explicit alias precedence, and nested-manifest repair guidance.
- [x] 4.2 Add an English changeset that explains the stricter nested-root rejection and the available repair choices.
- [x] 4.3 Run the complete build and test suite and confirm the generated CLI bundle remains consistent with the TypeScript sources.
- [x] 4.4 Validate the OpenSpec change and reconcile any implementation-driven wording changes across proposal, design, specs, and tasks before archive.
