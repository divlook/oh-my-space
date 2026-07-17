## Context

OMS currently treats the nearest ancestor containing `oms.yaml` as the workspace root. That behavior enables commands to run from the root and from a configured submodule, where selected commands can infer the current alias. The locator only checks existence, however, and the Git preflight only checks whether the manifest directory is somewhere inside a work tree. A manifest below an existing Git top-level can therefore make file-system operations use one root while Git index and submodule operations use another.

The current product manages submodules, but planned clone and worktree modes mean workspace identity must not permanently depend on every managed checkout sharing the root repository's Git topology. This change must harden the current submodule preconditions without implementing or constraining those future modes.

## Goals / Non-Goals

**Goals:**

- Give nearest-manifest discovery explicit, fail-closed behavior.
- Preserve root and configured-submodule execution, including current alias reporting and existing alias selection precedence.
- Prevent submodule topology operations from mixing a manifest directory with a different root Git top-level.
- Make `oms init` refuse to create that invalid nested layout before writing any file.
- Keep workspace discovery conceptually separate from current managed-checkout resolution.

**Non-Goals:**

- Implement clone mode, worktree mode, external checkout discovery, or a checkout registry.
- Require every future OMS workspace to be a root Git repository.
- Change the status JSON schema or broaden which commands infer an omitted alias.
- Add a root override flag, environment variable, or fallback from an invalid nearer manifest.
- Relocate existing manifests or mutate repositories to repair an invalid layout automatically.

## Decisions

### 1. Resolve the nearest manifest and fail closed on a nearer invalid candidate

Workspace discovery walks from the absolute current directory toward the filesystem root. The first `oms.yaml` directory entry is authoritative. A regular file, including a symbolic link whose target is a regular file, is returned as the workspace manifest. A broken symbolic link, a link to a non-file target, any other non-file entry, or a manifest that later fails parsing or validation produces an error and stops discovery.

This preserves the conventional nearest-project behavior and prevents a malformed inner workspace from being silently ignored in favor of an outer workspace that a mutating command could then change. Continuing upward after an invalid candidate was considered and rejected because it makes command scope depend on whether the nearer file happens to parse.

### 2. Keep workspace location separate from current submodule context

The workspace locator returns the manifest path and its containing root. After the manifest is validated, current submodule context is derived independently by checking whether the current directory is inside `oms/<configured-alias>/`. Existing command policy remains authoritative: an explicit alias wins, and only commands that already support current-path inference use the inferred alias.

This avoids treating the present `oms/<alias>` layout as the permanent definition of all managed checkouts. A future mode can add a different checkout resolver while continuing to use the same workspace identity. Arbitrary descendants can still locate the workspace, but they do not acquire a current alias unless they match a configured submodule path.

### 3. Canonicalize only for identity comparison

Diagnostics and status output continue to use the resolved workspace path expected by the current CLI contract. When comparing the manifest directory with Git's `rev-parse --show-toplevel` result, both paths are canonicalized through the filesystem so equivalent symlink spellings compare equal.

Canonicalization is limited to comparison rather than changing every emitted path. This fixes the safety decision without silently changing `status --json` path representation or requiring a schema migration.

### 4. Apply Git-root validation as a submodule-mode precondition

Commands that inspect or mutate root submodule state validate that the manifest directory is the canonical root Git top-level. A mismatch is an input/precondition error and must be reported before topology, index, manifest, or managed-directory side effects. The diagnostic names both paths and tells the user to move the manifest to the root or initialize a separate repository at the intended workspace root.

The shared submodule-loading preamble owns this check for `status`, `commit`, `record`, `branch switch`, `branch checkout`, `branch list`, `branch delete`, `fetch`, `pull`, `push`, and `unsync`. `sync --list` remains manifest-only so it can list a prepared manifest before Git initialization; mutating `sync` performs the same Git-root validation before selection or mutation. `doctor` performs the identity check directly so it can diagnose a missing, mismatched, or indeterminate root instead of allowing later checks to describe misleading submodule state.

This validation is deliberately not the definition of workspace identity. A future pure-clone workspace may not need a root Git repository, while a mixed workspace will apply the root requirement only to operations whose mode needs it.

### 5. Preflight `oms init` before scaffolding

Before creating or overwriting `oms.yaml`, `oms init` asks Git for the enclosing top-level. If no enclosing work tree exists, initialization proceeds and retains the existing guidance to run `git init`. If the current directory is the canonical top-level, initialization proceeds normally. If the current directory is below that top-level, initialization fails before writing `oms.yaml` or changing ignore files. If Git inspection or canonicalization cannot determine which case applies, initialization also fails before any write.

Automatically redirecting initialization to the enclosing Git root was rejected because `init` promises to scaffold the current directory and must not write somewhere the user did not request.

### 6. Test behavior at public command boundaries

Tests cover nearest nested manifests, non-file candidates, canonical path equality, a nested manifest below a Git top-level, initialization inside and outside Git, and preservation of current alias inference. Tests assert the absence of disk and Git side effects for rejected contexts.

## Risks / Trade-offs

- **Existing nested manifests stop working for submodule commands** -> Emit both the manifest directory and actual Git top-level with explicit repair choices; do not mutate either location automatically.
- **Filesystem canonicalization can fail because a path disappears or becomes unreadable** -> Treat an indeterminate identity as a preflight failure before mutation and provide a retry diagnostic.
- **Discovery remains available from arbitrary descendants** -> Keep alias inference restricted to configured `oms/<alias>` paths; document that discovery and current-checkout inference are separate behaviors.
- **The current submodule-specific check could leak into future modes** -> Name and place the validation as a submodule precondition, not as a universal workspace invariant.
- **Nearest-manifest semantics can make an outer workspace unavailable from an inner invalid workspace** -> Fail closed intentionally and require the user to move to the outer workspace when that is the desired target.

## Migration Plan

1. Introduce the structured workspace locator and canonical Git-top-level comparison.
2. Route shared submodule preflights, mutating sync, doctor, and init through the appropriate validation paths.
3. Add regression tests before changing documentation.
4. Update README and help wording to describe nearest-manifest and current-alias behavior.
5. Release the stricter nested-root rejection with an actionable migration note.

Rollback requires restoring the previous preflight behavior; no persistent data migration is performed by this change.

## Open Questions

- None for the current submodule-only scope. External checkout discovery and checkout identity belong to the future clone/worktree changes.
