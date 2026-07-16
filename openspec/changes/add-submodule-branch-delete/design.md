## Context

OMS currently exposes `switch` and `checkout` as top-level commands backed by `scripts/lib/branch-ops.ts`, but users must leave the OMS workflow to delete a local branch in the correct nested repository. Local branch discovery and initialized alias selection already exist, while interactive CLI tests currently run only through non-TTY `spawnSync` calls.

Branch deletion is submodule-local: deleting an inactive local ref does not move HEAD, update the root gitlink, or delete a remote ref. The safety model depends on knowing every branch OMS can treat as the baseline. `oms.yaml` is declarative source of truth, but an existing submodule's `.gitmodules` metadata can currently drift because the initialized sync path does not reconcile it.

## Goals / Non-Goals

**Goals:**

- Provide one-branch-at-a-time local deletion through `oms branch delete [alias] [branch]`.
- Make action, alias, and branch selection explicit and discoverable in interactive terminals.
- Preserve current and baseline branches under every deletion mode.
- Delegate merge safety to Git while offering one deliberate force escalation.
- Keep initialized-submodule deletion independent from network, remote refs, and root repository state; permit targeted network access only to prepare an explicitly named registered submodule.
- Reconcile and finalize baseline metadata during sync without a separate review, commit, or rerun when OMS can determine the safe result.
- Test interactive flows deterministically without a PTY dependency.

**Non-Goals:**

- Adding a public branch list command, multi-branch deletion, or delete aliases such as `rm`.
- Moving the existing top-level `switch` or `checkout` commands.
- Deleting remote branches or remote-tracking refs.
- Displaying or independently calculating merged/unmerged status.
- Adding JSON output.
- Automatically changing an attached submodule's current working branch during sync.

## Decisions

### Introduce a branch command group without moving existing commands

`oms branch` becomes a Commander command group and `delete` is its only initial subcommand. Interactive bare invocation presents an action selector even while only `delete` exists, so a destructive action is never implied and future actions can use the same entry point. `oms switch` and `oms checkout` remain unchanged at the top level.

Bare `oms branch` in a non-interactive shell follows the existing `oms agent` command-group pattern: print help and exit 1. Cancelling action, alias, or branch selection also exits 1 without running Git.

Alternative considered: enter deletion directly because it is the only action. An explicit selector better communicates intent and avoids changing bare-command behavior when another action is added.

### Select one initialized alias and one local branch explicitly

Omitting the alias always presents initialized aliases, even when invoked inside `oms/<alias>/` or when only one alias exists. After alias selection, omitting the branch presents all local branches in name order, even when only one deletable branch exists. Current and baseline branches remain visible with disabled options and reason hints; a branch that is both current and baseline shows both reasons.

Omitted aliases remain limited to initialized submodules so a destructive target is never inferred. When an explicitly named alias is registered in the root gitlink and `.gitmodules` but not initialized, deletion runs the equivalent of a targeted `git submodule update --init` automatically, which may access only that alias's registered remote and may update local submodule config and its worktree. It then resolves all protections and branch existence from the initialized repository before deleting. A detached HEAD is allowed whenever it exactly equals the root-recorded gitlink, which anchors that commit across invocations; OMS does not attach or move it. Any other detached state remains rejected. Initialization failure exits 2 with the original Git error and leaves Git's resumable partial initialization state intact rather than deleting fetched data. It does not create missing root topology; an unregistered alias fails with targeted sync guidance because no local submodule branch can yet be established safely.

If no initialized aliases exist for interactive selection, deletion fails with sync guidance. If an initialized alias has no deletable branches, the command summarizes protected branches and exits 0 without opening an unusable selector. Explicitly naming a missing local branch is a usage error after any automatic initialization; when a same-named remote-tracking branch exists, the error explains that deletion is local-only.

Alternative considered: infer the alias or auto-select sole candidates. Explicit choices are safer for a destructive action and match existing branch-command alias selection.

### Resolve every applicable baseline before deletion

The protected set contains the explicit `oms.yaml` branch and every different branch recorded for the selected alias in applicable worktree, index, conflict-stage, and `HEAD` versions of `.gitmodules`. Applicable versions are an existing worktree file, index stage 0 or every present unmerged stage 1-3, and the `HEAD` blob when present; an absent version contributes no baseline. OMS parses every applicable version and protects their union so staged drift or a root operation does not unnecessarily block deletion. An unreadable existing version, invalid Git config syntax, a duplicate selected-alias section, or multiple values for a selected alias's `path` or `branch` is not reliable and fails closed with the source version identified. Drift protects all discovered baselines and emits a warning, while unrelated branch deletion remains available. A later `oms sync` reconciles the metadata and releases obsolete protection.

When `oms.yaml` omits `branch`, the desired baseline is the locally detected `origin/HEAD`; a different `.gitmodules` branch remains protected until reconciliation. If the remote default cannot be resolved, deletion fails closed and asks the user to declare `branch` or repair origin HEAD. When `oms.yaml` explicitly declares a branch, the remote default is not separately protected unless `.gitmodules` records it.

Force never bypasses current or baseline protection. A detached HEAD that differs from the root gitlink rejects every deletion because deleting a ref can make the detached commit harder to recover. A detached HEAD equal to the root gitlink is durably anchored by root history and may proceed without moving or attaching HEAD, including on a later retry after automatic preparation.

### Keep unrelated repository state independent

Dirty files in the selected submodule do not block deletion because an inactive branch ref does not touch the worktree or index. Dirty root state and root merge/rebase state do not block deletion when every applicable baseline metadata version can be parsed, because deletion does not mutate root tracked state. Automatic initialization may update root-local submodule config but not root topology or commits. Unreadable or malformed applicable baseline metadata fails closed. A merge, rebase, `git am`, cherry-pick, revert, bisect, or sequencer operation inside the selected submodule blocks deletion until resolved, continued, or aborted. OMS detects these states through `MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, and `sequencer` under the submodule Git directory; the presence of any listed marker fails closed.

Linked worktree branch protection is delegated to Git rather than duplicated in OMS. This can make a force retry fail for the same reason as safe deletion, but retains Git as the authority for uncommon raw-worktree setups.

### Delegate deletion and merge safety to Git

After any automatic preparation and safety validation, normal deletion runs `git branch -d -- <branch>` inside the selected submodule. `-f, --force` runs `git branch -D -- <branch>` directly, regardless of whether alias and branch were supplied or selected. Explicit targets and interactive branch selection both count as target confirmation; successful safe deletion does not add another yes/no prompt. This deletion phase performs no network or root-state mutation.

OMS captures the branch tip full OID before attempting deletion and derives a short SHA for normal success output. Immediately before the initial `-d` and every `-D`, OMS re-resolves the protected set and listed submodule Git-operation markers from current state; a newly protected target or newly active operation aborts with exit 2 as a concurrent safety change. Immediately before every `-D`, OMS also re-reads the full OID and aborts with exit 2 when it differs. These are best-effort guards: Git exposes no porcelain command that combines the checks with `git branch -d` or `-D`, so a narrow race remains between final validation and deletion. Normal success output includes alias, branch, and prior short SHA. Before force deletion, OMS prints the full OID plus a POSIX-shell-safe recovery command of the form `git -C oms/<alias> branch <branch> <full-oid>`; forced success then confirms completion. No fetch, push, remote prune, root staging, root commit, or `oms record` hint occurs.

### Offer one force retry after any safe-deletion failure

If safe deletion fails and the local branch remains, OMS displays Git's original error and asks once whether to force-delete. The prompt includes alias, branch, prior full OID, and a local-commit-loss warning, with No as the default. OMS does not parse localized Git output or reimplement per-branch upstream merge rules.

Accepting retries once with `-D`; success exits 0 and reports forced deletion and recovery guidance, while an OID change or final Git failure exits 2 without another prompt. Declining or cancelling after the failed Git operation exits 2. In a non-interactive shell, OMS prints the original failure and a complete shell-safe `oms branch delete <alias> <branch> --force` retry command, then exits 2. A direct `-f, --force` Git failure likewise preserves the original error and exits 2 without another prompt.

If the branch disappears between the failed safe operation and the existence recheck, the requested final state has been reached concurrently; OMS reports that it no longer exists and exits 0. A branch missing before the initial attempt remains a usage error with exit 1.

### Reconcile declarative metadata before one root finalization

Before mutating root topology, sync rejects an in-progress root Git operation or unmerged `.gitmodules`. It snapshots staged OMS paths and computes the validated successful result before mutation. A pre-staged selected gitlink or `.gitmodules` is consumed only when its blob and mode exactly match the corresponding validated commit result; any mismatch exits 1 before root mutation as user-owned state. The complete current `oms.yaml` remains the separately disclosed intentional-consumption exception. Unrelated staged paths remain untouched.

For each initialized existing or pending-removal-restored submodule, the selected alias's `oms.yaml` `remotes.origin` value is authoritative for both the local `remote.origin.url` used by fetch and the `.gitmodules` `url`. Sync reconciles the local origin to that manifest value before fetching; neither the previous local origin nor the existing `.gitmodules` URL takes precedence. After a successful fetch it validates an explicit `oms.yaml` branch against fetched origin refs. A missing branch marks that alias failed without changing that alias's `.gitmodules` metadata. When `branch` is omitted, sync refreshes `origin/HEAD` from the manifest-defined remote; failure to resolve the current default likewise fails that alias because OMS cannot infer the intended baseline.

Sync snapshots root `HEAD`, the real index, the exact current working-tree `oms.yaml` bytes and cryptographic hash, and `.gitmodules` before topology mutation, then computes the selected aliases' expected topology delta. After topology mutation, it verifies that actual `.gitmodules` equals that expected delta over the original snapshot while preserving unrelated content; a mismatch is a concurrent edit. It uses the verified result as the metadata snapshot. Immediately before finalization and again immediately before invoking Git commit, sync verifies `HEAD`, the working-tree `oms.yaml` bytes and hash, the real index, `.gitmodules`, and selected gitlinks against their expected snapshots. Any mismatch triggers full validation once against the new state when no root mutation has yet been committed; if the state cannot produce the same safe plan, sync aborts without committing user edits. A narrow race remains after the final manifest comparison because OMS does not lock the working-tree file, but the temporary index always receives the exact captured and validated bytes rather than re-reading the path.

Sync first computes every alias transformation in memory; a planning or validation error is deterministic and is not retried. For metadata application, the original snapshot means the verified post-topology `.gitmodules` content. It then records the original file mode, creates a same-directory owner-only temporary file, and serializes the complete plan there. It keeps the temporary file owner-only until atomically replacing `.gitmodules`, then restores the original mode. A failed temporary-file write or atomic replacement is retried once from a fresh temporary file only when the post-topology snapshot still matches; detected concurrent modification is never retried. A mode-restore failure is retried once. Any exhausted planning, application, replacement, concurrent-change, or mode-restoration failure prevents a commit and leaves topology changes as an unstaged, resumable working-tree result. Before replacement, `.gitmodules` remains at the post-topology snapshot; after an exhausted mode-restoration failure, reconciled `.gitmodules` remains owner-only and unstaged. The latter exits 2 and prints `chmod 0<mode> '<absolute-repo-root>/.gitmodules'`, with POSIX single-quote escaping for the path. Temporary files are removed on every path and are never staged or logged.

For each planned alias, origin URL is authoritative, an explicit branch is written, and an omitted branch removes the `.gitmodules` branch key. OMS-managed values overwrite unstaged manual drift while unrelated sections, keys, formatting, and file mode remain intact. Reconciliation does not switch an attached working branch. `sync --commit`, or a commit prompt accepted after all requested aliases succeed, finalizes successful aliases' topology and metadata together in one OMS commit. The commit intentionally uses the complete current working-tree contents of `oms.yaml`, not its staged blob, when the working tree differs from `HEAD`; this includes failed-alias declarations and other manifest edits and consumes any prior `oms.yaml` staging. Before committing, output lists `oms.yaml`, warns when failed aliases are represented, and states that the working-tree manifest replaces and consumes prior staging.

Every sync commit uses an owner-only temporary index created from the verified `HEAD`. Its `.gitmodules` starts from `HEAD` and applies only successful aliases' OMS-owned topology and managed `path`, `url`, and `branch` fields; it preserves unrelated keys from `HEAD` and never copies unrelated working-tree edits, including edits inside a successful alias section. The temporary index stages only this synthesized file, successful gitlinks, and the complete current `oms.yaml`.

Before creating the commit, OMS records a cryptographic hash of the real index, acquires the real index lock, and rechecks the hash while holding that lock. The temporary commit and real-index replacement occur under that ownership. After Git advances `HEAD`, OMS builds a replacement real index against the new commit, replays every prior staged entry except intentionally consumed `oms.yaml` and exact-matching committed OMS paths, and atomically installs it. Commit failure leaves `HEAD` and the real index unchanged.

Before invoking Git commit, OMS durably writes and fsyncs an owner-only intent marker containing the original `HEAD`, original index hash, planned commit tree, temporary and recovery index paths, then fsyncs its directory. Artifacts are created only after that marker exists, preventing untracked recovery files. After Git advances `HEAD`, OMS atomically transitions and fsyncs the marker with the created commit OID before installing the real index. Every `sync` or `unsync` invocation that can mutate root topology or metadata, and every `record` invocation, runs a shared recovery preflight before any root mutation. The preflight cleans a prepared marker only when `HEAD` and the real-index hash still match the recorded originals, promotes an advanced-`HEAD` prepared marker only when the commit has the recorded parent and planned tree, and installs committed recovery only while holding the real-index lock and matching recorded `HEAD` and index hash. A mismatch, malformed marker, or owner-namespaced orphan artifact is preserved and blocks the command with comparison guidance.

Atomic real-index installation is retried once. If the temporary-index commit fails before advancing `HEAD`, the real index remains byte-for-byte unchanged and OMS leaves its working-tree changes intact. If installation fails twice after `HEAD` advances or execution is interrupted, the original real index and durable marker remain. On the next OMS root finalization, a prepared marker with unchanged original `HEAD` and index is cleaned as an uncommitted attempt; a prepared marker with advanced `HEAD` is promoted to recovery only when the new commit has the recorded parent and planned tree. A committed marker automatically installs the recovery index only when locked `HEAD` and current index hash still match, then removes and fsyncs the recovery state. Any mismatch, malformed marker, or owner-namespaced orphan artifact is preserved and reported without overwriting user state. Temporary files and owned locks are removed on normal success and verified pre-commit cleanup; interrupt handlers remove only locks owned by this process.

For partial `sync --commit`, failed aliases' `.gitmodules` metadata and gitlinks remain absent from the synthesized commit, while their `oms.yaml` declarations remain in the intentionally complete working-tree manifest. A plain or interactive partial sync skips the commit prompt and leaves successful OMS changes unstaged. Without a requested or accepted commit, OMS leaves topology and metadata unstaged as the explicit no-commit result. Metadata-only interactive sync uses the same default-Yes commit prompt when all requested aliases succeeded. Output names only changed fields such as `url` and `branch`, never URL values.

### Add a guarded reusable prompt test seam

Interactive behavior is tested through `OMS_TEST_PROMPT_RESPONSES`, active only when `OMS_TEST_MODE=1` is also set. Its value is a JSON array of typed entries: `{"type":"select","value":"..."}`, `{"type":"confirm","value":true|false}`, or `{"type":"cancel"}`. Prompt wrappers consume action, alias, branch, force, and cancellation entries in order; a valid queue overrides non-TTY detection and no real prompt is opened. Malformed JSON, an unknown entry shape, a response type that does not match the next prompt, or entries left at command completion fail with exit 1 without fallback. Without both environment variables, normal TTY behavior is unchanged and injected responses are ignored.

This avoids a native PTY dependency while covering the command's decision paths through the existing built CLI integration harness. Tests still verify true non-interactive behavior without the response queue.

## Risks / Trade-offs

- [The action selector initially has one choice] -> Keep explicit destructive intent and a stable extension point.
- [Force can be offered for a failure that `-D` cannot solve] -> Attempt it only once and preserve Git's final error.
- [A stale remote-tracking ref influences Git's safe-delete decision] -> Keep deletion network-free and direct users to `oms fetch` when freshness matters.
- [Failing closed on an unknown remote default is stricter than raw Git] -> Preserve the baseline invariant and provide an explicit `oms.yaml` branch escape hatch.
- [Sync metadata reconciliation expands this change beyond the delete command] -> Limit it to existing declared URL/branch fields required to make baseline protection recoverable.
- [Refreshing origin HEAD can make branch-omitted sync fail where it previously continued] -> Prefer an explicit failure over silently protecting or attaching an unknown baseline.
- [Topology and metadata both modify `.gitmodules`] -> Snapshot after topology mutation, apply metadata against that expected state, and finalize both through one commit-or-unstage decision.
- [A multi-alias `sync --commit` partially fails] -> Use a temporary index and alias-scoped `.gitmodules` synthesis to commit successful aliases without absorbing failed-alias `.gitmodules` metadata, failed-alias gitlinks, or unrelated user changes; intentionally retain failed-alias `oms.yaml` declarations in the complete manifest, while plain partial sync remains unstaged without prompting.
- [The manifest differs from `HEAD`] -> Intentionally consume the complete current `oms.yaml`, including failed-alias declarations and prior staging, and disclose that scope before committing so declarative input and derived metadata stay together.
- [A temporary-index commit advances HEAD before real-index refresh fails] -> Keep the original index and an owner-only recovery index, report the commit OID and exact recovery command, and never silently discard staged entries.
- [User-owned staged or conflicted `.gitmodules` state cannot be safely attributed] -> Refuse before root mutation instead of committing, unstaging, or overwriting it.
- [An atomic metadata operation fails transiently] -> Retry only side-effect-free file application or mode restoration once; preserve conflict and permission failures for explicit resolution.
- [Branch tips can move while a force prompt is open] -> Compare the full OID immediately before every force deletion and abort on change.
- [A branch can still move between final OID comparison and `git branch -D`] -> Retain Git's linked-worktree protection, describe OID checking as best-effort, and print recovery information before deletion.
- [A lock-ignoring editor can modify `.gitmodules` between final comparison and replacement] -> Keep the comparison immediately adjacent to atomic replacement, preserve the original on detected change, and document the residual race rather than claiming compare-and-swap semantics.
- [Temporary metadata can contain credential-bearing URLs] -> Create temporary files owner-only and clean them up on every path without staging or logging URL values.
- [Test prompt injection exists in the production bundle] -> Ignore it unless both `OMS_TEST_MODE=1` and a response queue are present.

## Migration Plan

Command syntax remains compatible, but sync becomes stricter: a branch-omitted remote without a resolvable origin HEAD now fails until the user declares `branch` or repairs the remote HEAD, and an explicit branch missing from origin fails until it is pushed or corrected in `oms.yaml`. Sync also overwrites managed URL/branch drift from the manifest, rejects mismatched staged OMS paths, uses the complete working-tree `oms.yaml` instead of its staged blob for every sync commit, and can commit successful aliases during explicit partial `sync --commit`. In addition, `sync`, `unsync`, and `record` now recover verified durable finalization state before root mutation and stop on mismatched, malformed, or orphaned recovery state. Document the previous and new behavior, preflight review commands, blocking diagnostics, and recovery or retry guidance for each case in `docs/migrations/0.11.x-to-0.12.0.md`, link it from the README, and repeat the compatibility summary in the minor changeset.

## Open Questions

None.
