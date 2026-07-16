## 1. Branch Inventory Foundation

- [x] 1.1 Add typed Git inspection helpers that enumerate local branch names, configured upstreams (including gone upstreams), and per-branch ahead/behind counts without assuming `HEAD` or same-named remote branches.
- [x] 1.2 Add declared-remote ref enumeration that accepts a remote name, excludes symbolic `<remote>/HEAD`, distinguishes inspection failure from an empty namespace, and returns deterministically sorted branch names.
- [x] 1.3 Add a non-destructive baseline reporting path that returns every reliable manifest and `.gitmodules` baseline, unmatched reliable names, warnings, and explicit `known`, `incomplete`, or `unknown` state, while preserving the existing fail-closed resolver used by branch deletion.
- [x] 1.4 Make declared remote reconciliation report per-remote success or failure so branch listing can classify unavailable remotes without printing credential-bearing URLs or changing undeclared remotes.

## 2. Automated Alias Preparation

- [x] 2.1 Implement branch-list alias resolution: validate an explicit alias, automatically choose the sole declared alias, use the guarded selector for multiple interactive candidates, and reject ambiguous non-interactive omission with exact argument guidance.
- [x] 2.2 Show initialized, registered-uninitialized, partially registered, and unregistered state in the alias selector without inferring a target from the current directory; allow selection of partial state only to produce exit 1 repair guidance.
- [x] 2.3 Automatically initialize a selected registered-uninitialized alias with a targeted submodule update, preserve partial Git state on failure, and return the documented exit code and actionable retry guidance.
- [x] 2.4 For a selected declared-but-unregistered alias, add the guarded `sync and continue` or `cancel` choice, delegate accepted preparation to the existing sync workflow, and resume listing only after the alias is initialized; keep non-interactive use topology-neutral with `oms sync <alias>` guidance.
- [x] 2.5 Classify aliases by topology presence across root HEAD, index, and working tree; allow pointer OID movement, reject conflicts and pending topology additions or removals with repair guidance, and use a command-scoped manifest URL override when targeted initialization encounters registration URL drift.

## 3. Remote Refresh And Fallback

- [x] 3.1 Reconcile each manifest-declared remote, then fetch configured remotes sequentially in manifest order with `--prune`, recording `fresh`, `stale`, or `unavailable` state per remote.
- [x] 3.2 Retry each failed fetch exactly once without prompting, continue to later remotes after exhaustion, retain cached refs as stale, and represent a no-cache failure as an unavailable remote while preserving the Git diagnostic.
- [x] 3.3 After a successful origin fetch for a branch-omitted alias, refresh `origin/HEAD` automatically; convert refresh or resolution failure into a visible `incomplete` or `unknown` baseline warning according to the remaining reliable sources rather than a terminal list failure.
- [x] 3.4 Ensure degraded remote refresh still exits 0 when local refs are inspectable, while failure to inspect local refs exits 2 with the failed operation, preserved state, and bounded repair guidance.
- [x] 3.5 Redact URL userinfo, embedded tokens, and other credential-bearing URL components from every diagnostic in the branch-list invocation, including delegated sync output, without removing non-sensitive URL host/path or failure context.

## 4. Command And Output

- [x] 4.1 Add `oms branch list [alias]` and route it through a cohesive branch-list module without changing top-level `switch`, `checkout`, or existing branch-delete behavior.
- [x] 4.2 Extend bare interactive `oms branch` to offer list and delete through the guarded action selector; preserve help plus exit 1 for bare non-interactive invocation and cancellation.
- [x] 4.3 Render a deterministic selected-alias heading, baseline summary with `known`, `incomplete`, or `unknown` state and unmatched reliable names, LOCAL table, and REMOTE table with explicit empty groups, detached HEAD, current/baseline flags, upstream, ahead/behind, and per-remote freshness state.
- [x] 4.4 Keep the listing phase within its documented scope: never switch or mutate a branch, display a configured remote URL value as data, touch root gitlinks or files, stage or commit root state, or print an `oms record` hint; allow only non-sensitive URL host/path inside credential-redacted diagnostics and keep explicitly accepted root mutations owned by the existing sync workflow.
- [x] 4.5 Add command help that states automatic initialization, baseline summary states, declared-remote reconciliation and fetch, degraded cached fallback, scope boundaries, exit behavior, and representative explicit and interactive examples.

## 5. Integration Tests

- [x] 5.1 Add CLI tests for explicit alias listing, deterministic local/remote ordering, every declared remote, symbolic HEAD exclusion, unmanaged remote exclusion, empty groups, and detached HEAD output.
- [x] 5.2 Add tests for current and multiple baseline flags, manifest-omitted origin default refresh, baseline drift, malformed metadata degradation, configured upstream divergence, unmanaged configured upstream display without REMOTE inventory inclusion, no upstream, and gone upstream unknown counts.
- [x] 5.3 Add guarded-prompt tests for sole-alias auto-selection including sole unregistered non-interactive guidance, multi-alias selection including partial-state display and repair exit, non-interactive ambiguity, cancellation, and bare branch list/delete action routing with no unconsumed prompt responses.
- [x] 5.4 Add preparation tests for automatic registered-submodule initialization, manifest-over-registration URL initialization without root metadata mutation, pointer OID movement, conflicts and pending topology additions or removals, initialization failure with preserved partial state and credential-bearing diagnostic redaction, interactive sync-and-continue including its existing root finalization choices, preserved precondition/operational exit codes, and credential-redacted failure behavior, sync cancellation, and non-interactive unregistered guidance without root mutation.
- [x] 5.5 Add remote refresh tests for manifest URL reconciliation without URL disclosure, configuration failure with cached refs, sequential fetch/prune, one successful retry, exhausted stale-cache fallback, exhausted no-cache unavailable output, ref-inspection failure, successful empty namespaces, continuation to later remotes, credential redaction, and exit 0 degraded results.
- [x] 5.6 Add scope tests proving branch refs, checkout state, root HEAD, root index, root working files, undeclared remotes, and root gitlinks remain unchanged apart from documented submodule preparation, remote-tracking refresh, and root changes made by an explicitly accepted sync workflow.
- [x] 5.7 Add terminal-failure tests for unknown aliases, accepted sync precondition failure with exit 1, accepted sync operational failure with exit 2, and local-ref inspection failure, proving the documented exit code and that every non-zero path includes the reason, preserved state, and an actionable OMS or bounded Git remedy.
- [x] 5.8 Add baseline tests for stale cached `origin/HEAD`, reliable and unreliable source combinations, and reliable baseline names without matching local branches.

## 6. Documentation And Verification

- [x] 6.1 Document the OMS automation-first product invariant in the README: automate routine work, ask only for irreducible intent, and reserve actionable errors for impossible or unsafe completion.
- [x] 6.2 Document `oms branch list`, its automatic preparation and network behavior, freshness states, output fields, scope boundaries, and exit behavior in the README command flow and reference.
- [x] 6.3 Update `skills/oms-branch/SKILL.md` so agents use branch list for branch discovery and defer exact fields and behavior to `oms branch list --help`.
- [x] 6.4 Add an English changeset summarizing the new branch inventory and automation-first preparation behavior.
- [x] 6.5 Run `npm run build`, `npm test`, and `openspec validate add-branch-list --strict`; require every command to exit 0, then manually smoke-check bare `oms branch` and `oms branch list` in an interactive terminal.
