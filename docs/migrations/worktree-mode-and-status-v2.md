# Worktree mode and status schema v2

This release adds a workspace-wide worktree mode, replaces status schema v1 with v2, and raises the minimum Git version to 2.48.

## Before upgrading

1. Upgrade Git to 2.48 or newer. OMS requires relative linked-worktree metadata in every mode.
2. Update every `oms status --json` consumer to require `schemaVersion: 2` and branch on each repository's `mode` discriminator.
3. Keep `mode` omitted, or set `mode: submodule`, to preserve existing submodule behavior.

Status v2 adds workspace `mode`, `currentWorktree`, and `currentTarget`, permits `root: null`, and uses different submodule and worktree repository shapes. `oms.status.schema.json` is the normative contract.

## Switching modes

Choose the completion scope before mutation:

```bash
oms mode switch worktree --no-sync
oms mode switch worktree --sync
oms mode switch submodule --no-sync
oms mode switch submodule --sync
```

Use `--commit` only when OMS should create the scoped root commit. A transition journal and workspace mutation lock make interrupted transitions resumable; rerun the exact command printed by OMS. Do not run standalone sync while a transition journal exists.

Worktree mode does not pin source commits in parent history. Review publication and preservation diagnostics before allowing source topology removal. Mode switch never pushes to a remote.

## Rollback limits

A release that predates worktree mode cannot open worktree topology or status v2. Switch back to submodule mode and complete or resolve every transition before downgrading. A downgrade cannot reconstruct discarded dirty files, unpublished refs, metadata refs, or unreachable objects. Keep backups and publish or preserve local state before using force.
