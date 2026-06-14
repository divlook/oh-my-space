## Context

`add-oms-workspace-skill` made `oms status --help` the authoritative, version-matched source its skills defer to for `oms status --json` field semantics: it ships with the installed CLI, so it always matches the emitted `schemaVersion`, where a GitHub-hosted doc could drift. The `oms status --json` JSON contract is already specified under the `ai-submodule-workflow` capability's "Machine-readable workspace status" requirement; the gap is purely the documentation surface:

- `oms status --help` prints only `(schemaVersion, root, repos, pointers)` — missing `toolVersion`, `workspaceRoot`, `currentAlias`, and `errors`, and mislabelling `root.submodulePointers` as a top-level `pointers`.
- A `scripts/oms.ts` comment points the `schemaVersion` 1 contract at a `design.md` now archived under `openspec/changes/archive/`.

## Goals / Non-Goals

**Goals:**

- Make `oms status --help` an accurate reference for the `schemaVersion` 1 payload that an agent can rely on after the skills send it there.
- Fix the `pointers` mislabel and the missing top-level keys.
- Repoint the stale `schemaVersion`-contract comment at a live source.

**Non-Goals:**

- Changing the `oms status --json` payload or its `schemaVersion`. The contract is unchanged; only its documentation changes.
- Adding a README schema section. The skills defer to `--help` precisely to avoid the GitHub-versus-installed-CLI skew a README would reintroduce; `--help` stays the single documentation home.

## Decisions

### Decision: Concise grouped reference in `--help`, not an exhaustive dump

The payload has roughly two dozen fields across the top level, `root`, and each `repos[]` entry. Pasting all of them into `oms status --help` would make the help unreadable. Instead `--help` lists the seven top-level keys, calls out `root.submodulePointers` and its four arrays (the location most prone to scope confusion and the one currently mislabelled), and summarizes the per-repo `repos[]` entry. Exhaustive per-field semantics are not duplicated: the `oms status --json` output is itself self-describing (an agent can read the actual keys), so `--help` carries the shape and the non-obvious parts (where pointers live, what the pointer-state arrays mean) rather than every field name.

### Decision: Repoint the contract comment at the spec, not the archived design

The `JsonRepoStatus` comment ("See design.md for the stable schemaVersion 1 contract") referenced the `ai-submodule-workflow` change's `design.md`, now archived. Point it at the capability's spec (the live contract) and `oms status --help`, both of which survive archiving.

## Risks / Trade-offs

- `--help` summarizes rather than exhaustively lists fields → an agent needing a field not named in `--help` reads it from the self-describing `oms status --json` output or the spec; acceptable, because exhaustive enumeration would harm readability for every reader while adding little an agent cannot already see in the JSON.
