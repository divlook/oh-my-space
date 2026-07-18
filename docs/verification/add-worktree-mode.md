# Add worktree mode release verification

This inventory maps the final `add-worktree-mode` implementation to its release-blocking verification surfaces.

## Mutation and inspection inventory

- `scripts/oms.ts` routes every manifest, topology, source, ref, index, network, and branch mutation through `withWorkspaceMutation`; worktree `status`, `worktree list`, worktree `branch list`, and `doctor` remain lock-free.
- `scripts/lib/git.ts`, `scripts/lib/worktree-inspection.ts`, `scripts/lib/workspace-exclude.ts`, and `scripts/lib/doctor.ts` provide the read-only Git subprocess inventory. Tests require `GIT_OPTIONAL_LOCKS=0` for every lock-free command and compare complete workspace snapshots before and after inspection.
- `scripts/lib/root-tx.ts`, `scripts/lib/workspace-mutation.ts`, and `scripts/lib/mode-switch-journal.ts` own root transactions, mutation serialization, and transition recovery. Fault-injection tests cover retained state and idempotent retries.
- `scripts/lib/status.ts` is the only status-v2 producer. `scripts/lib/agent.ts`, the three published `skills/*/SKILL.md` files, README guidance, `oms.status.schema.json`, compile-time fixtures, and golden JSON fixtures are the complete in-repository and published consumer inventory.

## Scenario mapping

- Plain, enclosing Git-root, nested-Git, and moved workspaces: worktree sync/status integration tests.
- Foreign ownership, symlink collisions, external and locked worktrees, stale registrations, excludes, and orphan aliases: worktree lifecycle, unsync, and doctor integration tests.
- Prompt behavior and exit 0/1/2: guarded prompt-queue tests and aggregate remote/target failure tests.
- Status v2: runtime schema tests, `scripts/status-contract.fixture.ts`, and `tests/fixtures/status-v2/*.json`.
- Credential safety: endpoint policy tests plus the cross-channel and on-disk canary test.
- Init, README, context inference, marker kernel, and all published AI skills: CLI integration and literal-drift tests.

Any new command, status consumer, prompt, durable state file, output channel, or release environment must be added to this inventory and its corresponding test before release.
