## Section 0 Baseline

### Mutation inventory

The current CLI has no workspace-wide mutation-lock wrapper. The implementation must route the following entry points through the new common wrapper before they write any state:

| Entry point | Current mutation scope | Primary implementation |
| --- | --- | --- |
| `init` | `oms.yaml`, legacy `.gitignore` cleanup | `scripts/lib/init.ts` |
| `sync` | submodule topology, `.gitmodules`, refs, root HEAD and index | `scripts/lib/repo-ops.ts`, `scripts/lib/topology-commit.ts`, `scripts/lib/root-tx.ts` |
| `unsync` | submodule topology, `.gitmodules`, refs, root HEAD and index | `scripts/lib/repo-ops.ts`, `scripts/lib/topology-commit.ts`, `scripts/lib/root-tx.ts` |
| `commit` | selected source index, working tree, and HEAD | `scripts/lib/commit.ts` |
| `record` | root index and HEAD | `scripts/lib/commit.ts` |
| `fetch` | remote-tracking refs | `scripts/lib/manage-ops.ts` |
| `pull` | source refs, HEAD, index, working tree, and remote-tracking refs | `scripts/lib/manage-ops.ts` |
| `push` | remote refs and local upstream configuration | `scripts/lib/manage-ops.ts` |
| `branch switch` | source HEAD, index, and working tree | `scripts/lib/branch-ops.ts` |
| `branch checkout` | source refs, HEAD, index, working tree, and remote-tracking refs | `scripts/lib/branch-ops.ts` |
| `branch delete` | local refs; may initialize a registered submodule | `scripts/lib/branch-delete.ts` |
| `branch list` | currently initializes submodules, reconciles remotes, and fetches despite being presented as inspection | `scripts/lib/branch-list.ts` |
| `agent install/uninstall` | `oms/AGENTS.md`, `oms/CLAUDE.md` | `scripts/lib/agent.ts` |

`skills --install` and `update` mutate installations outside managed workspace Git state and remain outside the workspace mutation lock. Their non-installing/check-only forms are read-only.

Shared mutation helpers are `runGit`/`runSub` (`scripts/lib/git.ts`), `syncRepo`, `unsyncRepo`, `cleanupFailedAdd`, and `restorePendingRemoval` (`scripts/lib/repo-ops.ts`), `reconcileGitmodules` (`scripts/lib/gitmodules-reconcile.ts`), `attachBranch` and `ensureRemotes` (`scripts/lib/submodule-config.ts`), `finalizeTopology` (`scripts/lib/topology-commit.ts`), and the lock/index/ref/recovery helpers in `scripts/lib/root-tx.ts`.

The explicitly lock-free managed-state inspections are `status`, `doctor`, help, `worktree list`, and worktree-mode `branch list`. Current status Git subprocesses include `submodule status`, `rev-parse`, `rev-list`, `ls-tree`, `ls-files`, `for-each-ref`, `status --porcelain=v1 -z`, and `rev-parse --git-path`. Doctor invokes `git --version` and `rev-parse --show-toplevel`. Submodule-mode branch list preserves its existing mutating `submodule update --init`, remote reconciliation, and `fetch --prune` behavior under the workspace mutation lock. Worktree-mode branch list inspects only existing common refs and registrations. Every retained inspection subprocess receives `GIT_OPTIONAL_LOCKS=0`.

### Existing transaction and recovery behavior

Submodule sync and unsync use `recoveryPreflight`, topology reconciliation, and `finalizeTopology`. `finalizeRootCommit` in `scripts/lib/root-tx.ts` builds a private temporary index under `.git/oms`, synthesizes `.gitmodules`, writes gitlinks and blobs into that index, creates a tree and commit, acquires `refs/oms/finalize-lock` with compare-and-swap, persists `.git/oms/finalize.json`, advances HEAD with an expected-old-OID check, and atomically installs a recovery index. The real index is preserved until HEAD advancement succeeds.

Recovery recognizes prepared and committed markers, completes index installation after HEAD advancement, cleans a prepared transaction that did not advance HEAD, and fails closed on malformed markers, mismatched indexes, or orphan artifacts. Fault-injection points cover marker preparation, HEAD advancement, committed-marker persistence, index installation, and final index rename. Add cleanup removes only invocation-created submodule debris; removal recovery restores selected `.gitmodules` and gitlink state. The mode-aware implementation must preserve unrelated index entries, stages, modes, flags, root commit scoping, atomic `.gitmodules` replacement, fail-closed recovery, and idempotent retry behavior.

### Status and documentation inventory

Status schema v1 is produced by `scripts/lib/status.ts` through `JsonStatus`, `JsonRootStatus`, `JsonRepoStatus`, and `printStatusJson`, and is exposed by `scripts/oms.ts` plus `scripts/lib/help.ts`. In-repo consumers include status human rendering, gitlink/pin/topology helpers, commit/record hints and preflights, prompt alias resolution, branch deletion, and `tests/cli.test.js` fixtures.

Published consumers and synchronized guidance targets are the canonical kernel and marker block in `scripts/lib/agent.ts`, `skills/oms-workspace/SKILL.md`, `skills/oms-pointer/SKILL.md`, and `skills/oms-branch/SKILL.md`. Positioning and migration targets are `README.md`, `package.json`, `oms.schema.json`, `CHANGELOG.md`, and `docs/migrations/`; the new normative status contract belongs at repository-root `oms.status.schema.json`.

### Verified baseline

- Runtime selected by `.nvmrc`: Node `v24.11.0`; installed Git: `2.50.1`.
- `npm run build`: exit 0.
- `npm test`: exit 0; 262 passed, 0 failed, 0 skipped, duration 738860 ms.
- Running the suite under Node `v25.1.0` did not complete within 600 seconds and was discarded as a baseline because `.nvmrc` selects Node 24.
