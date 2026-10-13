# Design

## Context

See `proposal.md` for motivation and `specs/ai-submodule-workflow/spec.md` for the output contract. A design is warranted because this changes presentation across the command runner, help text, and CLI composition while preserving destructive-operation warnings and diagnostics.

`runBranchClean()` currently prepares the selected alias, builds a complete plan, prints the base, an unconditional preparation notice, a concurrency warning, and every branch, then checks whether candidates exist. `prepareAlias()` returns immediately for an initialized registration. The no-op path returns 0; deletion and final revalidation are isolated in `execute()`.

`branchCleanHelp` contains Base, Safety, Results, and Examples sections. The `clean` registration appends both that text and `workspaceContextHelp`. Detailed rules already exist at `docs/commands.md#oms-branch-clean` and `docs/how-oms-works.md#merged-branch-cleanup-safety`.

Integration coverage already exercises no candidates, cached bases, protected branches, initialization retention, inspection errors, shallow history, and concurrent changes. One cached-base case asserts a displayed full base even after the final candidate has been deleted; that assertion describes the old presentation, not an eligibility invariant. Existing black-box coverage owns production routing and deletion boundaries.

The predecessor `add-merged-branch-cleanup` has not been synchronized into the main spec. This delta modifies its complete `Explicit cleanup comparison base` and `Informed cleanup batch confirmation` blocks. Predecessor synchronization must precede this change's synchronization; planning and implementation can proceed against the already present code.

## Goals / Non-Goals

**Goals:**
- Branch output by candidate presence only after the existing inspection has succeeded.
- Preserve exceptional diagnostics independently of the full deletion-plan renderer.
- Keep preparation messages truthful about actual effects on every outcome.
- Reduce this command's help without introducing a second help framework or affecting other commands.

**Non-Goals:**
- No changes to alias selection, preparation, base resolution, ancestry, protected branches, worktree checks, transactions, configuration cleanup, recovery commands, or exit codes.
- No `--quiet`, `--verbose`, `--yes`, JSON, preview mode, or repository-wide help rewrite.
- No suppression of genuine safety warnings and no assertion that an empty plan means clean files or all work merged.
- No modifications to the predecessor's artifacts or automatic archive/sync operations.

## Decisions

### 1. Keep full planning, but choose the output before rendering it

Retain the existing preparation and `makePlan()` calls. Compute candidates immediately after successful planning. For an empty set, print the alias-specific no-op summary, actual preparation effects if any, and exceptional diagnostics, then return 0 before the full plan or concurrency warning is rendered. For nonempty plans, retain the full base, candidate tips, exclusions, warning, and default-No confirmation behavior.

An early return based only on branch count would skip protection or ancestry inspection and could misreport errors as success. A new preview or verbosity flag would add an unnecessary public contract. Neither is needed.

Keep shared baseline warnings emitted by existing inspection. Shallow-history limitations currently live only in branch exclusion text; preserve them in concise no-op output without dumping every ordinary exclusion. Carry that exceptional diagnostic from the point where shallow ancestry is found unproven, using a small module-local plan diagnostic field if needed. Do not classify diagnostics by matching English output strings, add extra Git reads, or build a generalized reporting abstraction. A single aggregate shallow-history notice with deepen-or-repair guidance is sufficient when no candidates remain; candidate plans keep their existing per-branch reasons.

### 2. Report only actual preparation effects

Reuse the current pre-preparation initialization state. An initialized source has no preparation-effects message. A source initialized by this invocation retains the existing truthful explanation of initialization and possible baseline/tracking effects. Emit that information in empty, candidate, failure, and decline outcomes where relevant; never substitute a claim that the invocation made no changes.

Do not alter the shared `prepareAlias()` interface or its logging. This keeps other commands unchanged and avoids inventing an effects-tracking subsystem for a local presentation issue.

### 3. Make help a quick reference and retain the existing detailed document

Retain Commander-generated usage, purpose, argument, and option sections. Put two examples first in the appended help, followed by a compact guidance paragraph and the existing safety-document URL. Include local-only deletion with interactive confirmation, the configured local base or cached `origin/HEAD` default, no automatic ref refresh after preparation, and possible automatic initialization. Aim for roughly one compact terminal screen at 80 columns during manual review; do not make exact wrapping, line count, or English phrasing a persistent API.

Remove `workspaceContextHelp` only from the cleanup registration, not from its definition or other command registrations. Keep discovery and repair behavior intact; the errors and documentation remain authoritative when those situations arise.

Do not add a verbose-help flag or remove detailed rules from documentation. The confirmation warning remains before destructive consent, not only behind a documentation link.

### 4. Verify behavior at the existing owners, inspect prose directly

Extend existing integration scenarios for an initialized protected-only no-op, ordinary unmerged no-op, initialization followed by no candidates, shallow-history limitations, and inspection failure. Verify no deletion prompt, preserved Git state, exit behavior, and the distinction between routine output and actionable diagnostics. Retain nonempty plan, confirmation, refusal, concurrency, and recovery coverage.

Delete the obsolete empty-path full-base output assertion in the cached-base scenario rather than re-pinning replacement wording. Continue proving base resolution through nonempty candidate behavior. Do not add exact prose snapshots, source-string checks, or forwarding tests. Extend existing owners without adding a black-box owner; update test inventory only if contract ownership changes.

After building, run `node dist/oms.js branch clean --help` from outside an OMS workspace to inspect the actual usage surface and prove help does not trigger preparation. Exercise the actual command in a disposable initialized fixture with no candidates, then in a candidate fixture that is declined; never use the user's source repository for a destructive smoke run. Run `npm run test:integration`, `npm run test:branch`, and the canonical `npm test` gate during implementation.

## Risks / Trade-offs

- Empty output hides routine reasons a topic branch was preserved -> use an explicitly eligibility-based no-op message, not a claim that every branch is merged; detailed rules explain ancestry and protection.
- Moving the early return can hide exceptional shallow-history or baseline diagnostics -> preserve exceptional diagnostics independently and cover the empty limited-history boundary.
- Concise help could hide prerequisites -> retain interactive confirmation, cached-base behavior, and possible initialization in brief guidance; leave full warnings in the confirmation path and detailed docs.
- Human-output consumers expecting a full base on a no-op will see less text -> this is an intentional human-facing output change; no structured-output API exists for this command.
- Applying the new delta before its predecessor reaches the main spec would fail requirement lookup -> synchronize the predecessor first, without modifying it in this planning workflow.

## Migration Plan

Implement the local reporting and help cutover, retain behavioral coverage, inspect bundled help and actual disposable-fixture interactions, then update the existing docs and add an English Changeset entry. Preserve all safety and recovery document sections and their link anchors. No data or configuration migration is required. Rollback restores the previous presentation only; it does not affect repository state or reverse any branch deletion.
