## Context

OMS already owns the branch workflow boundary for submodules through `switch`, `checkout`, and `branch delete`, but branch inventory still requires users to enter `oms/<alias>` and compose Git commands. Existing helpers can list local and `origin` branches, inspect the current branch, calculate current-branch upstream divergence, initialize a registered submodule, reconcile declared remotes, and resolve protected baselines. They do not yet provide one coherent snapshot for every local branch and every manifest-declared remote.

This change also records a product-level rule that has previously been implicit: OMS should complete routine work itself. A workflow should ask a person only for a decision OMS cannot infer safely; it should not turn an ordinary recoverable condition into instructions for manual Git repair. Terminal errors are reserved for impossible or unsafe completion and must explain both the cause and the next action.

Branch listing is read-oriented but not side-effect-free. The selected repository may be initialized, declared remote configuration may be reconciled, and remote-tracking refs are refreshed and pruned. The listing phase never moves a branch, creates root topology, or changes a root gitlink; only an explicitly accepted delegation to the existing sync workflow may perform its documented root mutations.

## Goals / Non-Goals

**Goals:**

- Make one OMS command produce a current, decision-ready branch inventory for one submodule.
- Apply the automation-first policy by performing safe preparation, remote reconciliation, refresh, retry, and degraded fallback automatically.
- Ask for an alias or topology-creation decision only when OMS cannot choose safely.
- Include every remote declared for the alias in `oms.yaml`, while excluding unmanaged local Git remotes.
- Distinguish fresh, stale, and unavailable remote results without discarding a usable local branch list.
- Show current and baseline flags, configured upstream, and per-local-branch ahead/behind counts.
- Preserve existing root/submodule scope boundaries and exit-code conventions.

**Non-Goals:**

- Listing every alias in one invocation.
- Adding JSON output, filtering flags, pagination, or custom sort options.
- Including manually configured remotes that are absent from `oms.yaml`.
- Switching, creating, deleting, merging, or pushing a branch.
- Creating missing root submodule topology except through an explicitly accepted delegation to the existing sync workflow.
- Showing worktree dirtiness, root pin state, commit subjects, authors, dates, or branch tip OIDs; the detached HEAD short OID is the sole OID exception.
- Changing the behavior or top-level location of `oms switch` and `oms checkout`.
- Retrofitting every existing OMS command in this change; the automation policy governs new and subsequently changed workflows.

## Decisions

### Treat automation-first behavior as a product invariant

New and changed OMS workflows follow a three-level decision model:

1. OMS automatically performs routine, deterministic, and bounded recovery or preparation.
2. OMS presents choices, with consequences, when safe completion depends on human intent.
3. OMS exits non-zero only when it cannot complete safely, and then reports the reason, preserved state, and an actionable remedy.

For branch listing, automatic work includes registered-submodule initialization, manifest-declared remote reconciliation, fetch/prune, one fetch retry, remote-default refresh, and cached-ref fallback. Creating missing root topology is a meaningful workspace mutation, so an interactive user chooses whether OMS should run the sync workflow; non-interactive use receives an exact `oms sync <alias>` remedy.

Alternative considered: keep every preparatory action explicit and fail with Git commands. Rejected because it preserves the manual workflow OMS exists to remove and violates the stated product invariant.

### Resolve exactly one alias, minimizing unnecessary prompts

`oms branch list <alias>` validates a manifest alias directly. Alias state is determined from both required root registration elements: a gitlink and a matching `.gitmodules` entry. Automatic initialization requires the topology's presence to agree across root HEAD, index, and working tree; differing gitlink OIDs alone are allowed because they represent pointer movement rather than topology drift. A conflict, pending topology addition or removal, or disagreement about either registration element is `partially registered`, unsafe for automatic preparation, and exits 1 with sync repair guidance. An alias is `initialized` when the agreed registration exists and its submodule worktree is initialized, `registered-uninitialized` when registration exists without an initialized worktree, and `unregistered` when every snapshot consistently lacks registration.

Without an alias, OMS auto-selects the only declared alias. In a non-interactive invocation, an auto-selected unregistered alias exits 1 with exact `oms sync <alias>` guidance rather than asking for the alias again; multiple declared aliases exit 1 and require an explicit alias. An interactive invocation presents the selector when several declared aliases exist. The selector includes every declared alias and its initialized, registered-uninitialized, partially registered, or unregistered state.

A selected registered-uninitialized alias is initialized automatically with a targeted `git submodule update --init -- oms/<alias>`. When its registered URL differs from `oms.yaml`, the targeted initialization uses the manifest URL through a command-scoped override; it does not rewrite root `.gitmodules`. A declared unregistered alias cannot be prepared without creating topology. In a TTY, OMS offers `sync and continue` or `cancel`; accepting delegates to the complete existing sync workflow, including its topology, metadata, commit-or-unstage decisions, and exit codes, and resumes listing only after successful initialization. Off-TTY, or after cancellation, OMS exits 1 with the reason and exact sync command. An automatic initialization failure exits 2 with a credential-redacted Git error and preserved partial state; an accepted sync failure returns sync's existing exit code. Credential redaction wraps every diagnostic emitted during this branch-list invocation, including delegated sync output; it removes credential components while retaining non-sensitive URL host/path and failure context.

Alternative considered: always prompt when alias is omitted, including a single candidate. Rejected because a single non-destructive target requires no human judgment. Current-directory inference was also rejected because the chosen command contract is explicit selection rather than location-dependent behavior.

### Reconcile only manifest-declared remotes before refresh

The `remotes` map in `oms.yaml` defines the managed remote set and order. Before fetching, OMS ensures each declared submodule-local remote exists and uses the declared URL. Unlike sync metadata reconciliation, branch listing does not rewrite root `.gitmodules`. Extra local Git remotes are neither changed nor included in the REMOTE inventory. Their names may still appear in a local branch's configured upstream field because that field reports the actual tracking relationship. OMS never prints a configured old or new URL value as data; a credential-redacted Git diagnostic may retain its non-sensitive URL host/path as failure context.

If one declared remote cannot be configured, it is classified as unavailable without fetching or displaying cached refs for that remote, and processing continues with later remotes. If configuration and fetch succeed but the remote ref namespace cannot be inspected, that remote is also unavailable. If fetch succeeds and the namespace is empty, the remote remains fresh with an explicit empty group. If an exhausted fetch has cached refs but those refs cannot be inspected, unavailable takes precedence over stale. These degraded states do not change exit 0 while local refs remain inspectable.

Alternative considered: list every `refs/remotes/*` namespace. Rejected because stale manually added remotes would escape the manifest boundary and make output differ across otherwise equivalent OMS workspaces.

### Fetch declared remotes sequentially, retry once, then degrade visibly

Each configured declared remote runs `git fetch <remote> --prune` in manifest order. Fetches are sequential because concurrent fetches in one repository can contend on refs, lock files, and `FETCH_HEAD`. A failed fetch is retried once immediately. After a second failure, OMS preserves Git's error with URL userinfo, embedded tokens, and other credential-bearing URL components redacted, warns that the remote view may be stale, and continues to the next remote.

Cached refs for an exhausted remote remain visible with fetch state `stale`. If no cached refs exist, the remote appears once as `unavailable` rather than disappearing. Exhausted remote failures do not change an otherwise successful list's exit code from 0: the command fulfilled its primary purpose with an explicit degraded result and no manual step is required merely to inspect local state.

Alternative considered: fail fast or return exit 2 after displaying cached refs. Rejected for this command because both approaches discard or machine-classify a useful automated fallback as total failure. The visible fetch state and warning prevent stale data from being mistaken for fresh data.

### Refresh an omitted origin baseline automatically

When `oms.yaml` declares a baseline branch, that branch is reliable without consulting a remote default. When it omits `branch`, a successful origin fetch is followed by `git remote set-head origin -a` so `origin/HEAD` reflects the current remote default. Cached `origin/HEAD` after a failed fetch is not treated as reliable. Failure to refresh or resolve the default does not block listing.

Reliable `.gitmodules` branch values remain part of baseline reporting so drift can flag more than one local branch, matching deletion's protection model. The result is `known` when all applicable sources are reliable and at least one baseline is resolved, `incomplete` when at least one reliable baseline exists alongside an unreliable applicable source, and `unknown` when no reliable baseline exists. Every reliable baseline with a matching local branch is flagged; reliable names without a local match are reported in the baseline summary. Malformed, unreadable, duplicated, or multi-valued metadata and untrusted cached `origin/HEAD` produce a warning and `incomplete` or `unknown` state rather than a terminal failure. All three baseline states retain exit 0 while local refs remain inspectable.

Alternative considered: reuse deletion's fail-closed baseline resolver unchanged. Rejected because the consequence of incomplete labeling is visible uncertainty, not destructive branch loss.

### Build one stable branch snapshot and attach local decision state

OMS enumerates local refs under `refs/heads` and remote-tracking refs only under each declared `refs/remotes/<name>` namespace. Symbolic `<remote>/HEAD` refs are excluded. Names are sorted first by local branch name, then by declared remote order and remote branch name.

Each local row reports:

- branch name;
- `current` and zero or more `baseline` flags;
- configured upstream short name, including a gone upstream;
- ahead/behind counts calculated between that branch and its actual upstream.

Ahead/behind is not inferred from same-named remote branches. If no upstream exists, both values are blank. If an upstream is configured but cannot be resolved or compared, both values are `?`. Remote rows report remote name, fetch state, and branch name; ahead/behind does not belong to a remote ref by itself.

Detached HEAD does not block listing. OMS prints the detached short OID above the table and no local row receives `current`.

Alternative considered: add commit OIDs and subjects. Rejected because they widen and destabilize the table without helping the immediate switch/checkout/delete decision.

### Keep output human-readable and reserve terminal errors for unusable local state

The command prints a selected-alias heading, a baseline summary with `known`, `incomplete`, or `unknown` state and unmatched reliable names, a LOCAL table, and a REMOTE table. Remote status is `fresh`, `stale`, or `unavailable`; degraded states are repeated in warnings. Empty local or remote sections are represented explicitly instead of treated as failures.

Exit 0 covers fully fresh and clearly marked degraded lists. Exit 1 covers unknown aliases, ambiguous non-interactive alias omission, partial registration, cancellation, declined topology creation, and manifest/config usage errors that prevent selecting a repository. Exit 2 covers failed automatic initialization and inability to inspect the selected repository's local refs. An accepted sync failure preserves sync's existing exit code, including exit 1 for precondition or usage failures and exit 2 for operational Git failures. Every non-zero path names the failed step, states what OMS preserved, gives an OMS command or bounded Git remedy, and redacts credentials from preserved diagnostics.

No JSON mode is added. `oms status --json` remains the machine-readable current-state interface; branch inventory is initially a human workflow.

### Extend the existing branch action group

Bare interactive `oms branch` presents `list branches` and `delete a local branch`. Selecting list enters the same alias-resolution flow as `oms branch list`; selecting delete preserves current behavior. Bare non-interactive `oms branch` continues to print help and exit 1, now showing both subcommands.

## Risks / Trade-offs

- [Every list invocation performs network I/O and can be slow] -> Show per-remote fetch steps, process deterministically, and keep cached fallback so one outage does not discard all results.
- [Immediate retry cannot repair authentication or permanent URL errors] -> Limit retry to one, preserve the credential-redacted Git diagnostic, and mark the affected remote stale or unavailable.
- [Exit 0 can conceal degraded freshness from scripts] -> Emit warnings and an explicit fetch-state column; JSON and scripting guarantees remain out of scope.
- [Remote reconciliation changes submodule-local Git config] -> Limit changes to manifest-declared names and URLs, never remove extra remotes, never print configured URL values as data, and allow non-sensitive host/path only inside credential-redacted diagnostics.
- [Interactive sync can create root topology from a list command] -> Require an explicit `sync and continue` choice and delegate all topology and commit decisions to the established sync workflow.
- [Baseline sources can disagree or be malformed] -> Flag every reliable baseline, warn on drift, and display `incomplete` when another reliable baseline remains or `unknown` when none remains.
- [Refs can move after fetch while the table is assembled] -> Treat output as an observational snapshot, collect it immediately after refresh, and avoid claiming transactional consistency.
- [Large branch sets can produce long output] -> Keep deterministic grouping and sorting; filtering and pagination can be added later without changing the base contract.

## Migration Plan

The change is additive. Release the new subcommand, help, documentation, and workspace branch skill update together. Existing branch, switch, checkout, status, and delete syntax remains compatible. Rollback removes the new command and action without data migration; fetched refs and reconciled submodule-local remote configuration are valid Git state and need no cleanup.

## Open Questions

None.
