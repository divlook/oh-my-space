# Design

## Context

See [proposal.md](proposal.md#why) for the motivation and the [workflow](specs/ai-submodule-workflow/spec.md) and [automation](specs/cli-automation-policy/spec.md) deltas for the behavior contracts. `finalizeTopology()` currently defaults to committing when its caller supplies no option. `aliasRegistration()` expects both a gitlink and a matching `.gitmodules` entry in root `HEAD` and the index, so it cannot distinguish a successful unstaged addition from a broken registration.

## Goals / Non-Goals

**Goals:** Give all registration workflows one commit decision and one registration classifier. When commits are disabled, leave staging to the existing Git operations. Preserve the existing safeguards on commit-enabled runs.

**Non-Goals:** Do not add a commit prompt, change source pointer recording or status JSON, or relax eligibility for commands that require committed registration. Do not redesign the root commit transaction or its recovery protocol.

## Decisions

### Resolve commit intent before calling the finalizer

Validate `autoCommit` with the rest of `oms.yaml` and carry the resulting boolean with the loaded workspace, separate from the source declarations. Reject simultaneous `--commit` and `--no-commit` at CLI parsing, regardless of order, before either command can mutate the repository. Do not collapse the flags into a single last-option-wins value. After validation, direct `sync` and `unsync` resolve `options.commit ?? autoCommit`; leaving the option undefined is distinct from passing `--no-commit`. Shared preparation uses the workspace value and shows the actual commit consequence in its registration offer. Carry the decision through to sync and finalization as a required boolean so neither falls back to its own default. Before delegated sync mutates topology, check that the setting in the captured manifest still agrees with the offer; if it changed, stop and ask the user to rerun rather than commit under different terms. Resolving intent in the finalizer would be too late to describe the effect of consent or reject an invalid setting before mutation.

### Separate no-commit finalization from the commit transaction

Reuse root preflight, safety checks, and the existing path-limited transaction for enabled commits. Preserve sync's successful-alias isolation and unsync's all-or-nothing commit decision. With commits disabled, skip checks that exist only to protect or preserve staging; continue to enforce the existing conflict, in-progress operation, and checkout safety checks.

Do not inspect the result just to describe staging or capture, restore, or reset the index to undo incidental staging. The Git operations that perform registration, removal, or restoration may change the index, including entries that were already staged. This applies on success and partial failure. Retain operation errors and document the staging effect in help and user guidance instead of emitting a separate staging notice at runtime.

Run `recoveryPreflight()` even when root commits are disabled. It can complete an earlier authorized operation but does not create a new commit; stop before new mutations if the recorded state cannot be verified.

Keep finalization resumable. On a later `sync --commit`, determine pending managed metadata by comparing the successful alias plans against the committed `.gitmodules`, not just by checking whether reconciliation edited the working file in this run. Use the same selected paths and transaction as for fresh changes. Repeating `unsync --commit` uses the existing pending-removal detection. No marker is needed solely to remember an uncommitted registration change; the Git state is the source of truth.

Help and migration guidance explain that `--no-commit` does not mean `--no-stage` and Git may restage an affected path, including pre-existing edits. Users who rely on a particular staged selection should review or save it before running the command.

### Classify pending registration separately from broken registration

Add a pending state in `alias-registration.ts`; do not use `pendingAddTopology()` or the presence of `.git` alone as proof. Check that the alias is absent from committed registration, the canonical path resolves to its own usable checkout with a readable commit, and the working `.gitmodules` has exactly one matching registration. Apply the same checkout ownership check as `oms exec`: the resolved checkout root must be the canonical path, and its resolved Git directory must match the main project's Git-managed modules path for that alias. A separate clone at the right path does not qualify. In the root index, accept either no entries for the alias's registration or a compatible stage-zero gitlink and matching registration entry. A conflict, non-gitlink entry, duplicate or conflicting mapping, or failed inspection is not evidence of a valid pending addition. Compare registration identity, not the staged and checked-out commit IDs: source work can move the checkout without making the registration broken.

Use the same preparation decision for single and batch commands, both for existing aliases and after delegated sync. Apply the explicit eligibility list in the workflow spec rather than inferring it from whether a command writes root paths. Keep the existing rules on which commands may offer registration, and do not let the initialized-checkout exception admit conflicted or incomplete registrations. Give commands that refuse a valid pending registration explicit `oms sync <alias> --commit` guidance. `oms exec` retains its separate no-preparation path. Using the same classifier for both preparation paths avoids a first run that succeeds after delegated sync but fails on the second run with the same Git state.

### Distinguish alias failures from shared finalization failures

Return per-alias registration outcomes and shared finalization status separately from the delegated sync workflow. Direct `sync` still reports the aggregate exit code. For delegated preparation, a successful shared finalization allows eligible aliases that succeeded or needed no preparation to continue; reclassify successful additions before using them, but never upgrade a failed alias merely because a checkout exists. A failed shared commit or index finalization blocks all follow-on operations, including those for already registered aliases, and retains the original failure and recovery guidance. An aggregate exit code alone cannot distinguish these cases.

## Risks / Trade-offs

- Scripts that expect `sync` or `unsync` to advance main-project `HEAD` will no longer do so by default → Update usage and migration guidance to show explicit `--commit` for scripts and `autoCommit: true` for workspaces that want the previous default.
- A valid addition and a broken registration can look similar from a single Git snapshot → Check committed, staged, and working state together; exercise both unstaged and consistently staged additions as well as conflict and wrong-entry cases.
- A delegated batch can leave successful additions pending alongside failed aliases → Recheck successful additions and retain the failed aliases' outcomes. If shared finalization fails, stop before the requested source operation and report whether root `HEAD` advanced. Keep the existing Git safety diagnostics and credential redaction.

## Migration Plan

Ship the manifest schema, CLI behavior, help, and user guidance together. Existing manifests need no edit to use the new default. Users can restore automatic commits in a workspace with `autoCommit: true`, or add `--commit` to individual direct calls. Prefer the flag in scripts that also run against older OMS versions, which already accept it but do not know the manifest key. Before rolling back to an older version, remove the key and finalize any pending changes that its preparation checks cannot use, or keep those changes for manual review before running dependent OMS commands.
