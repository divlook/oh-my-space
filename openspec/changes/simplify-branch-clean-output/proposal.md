# Proposal

## Why

`oms branch clean` prints a full deletion plan and a concurrency warning even when no branches can be deleted, making a successful no-op look concerning. Its help also mixes quick usage with detailed safety and recovery rules, burying examples beneath a screenful of text.

## What Changes

- For a successfully inspected, already initialized source with no eligible branches, print one alias-specific no-op summary and exit 0 without a deletion prompt, base dump, branch inventory, routine preparation message, or deletion-concurrency warning.
- Continue reporting real initialization effects, safety diagnostics, inspection failures, and repair guidance; do not describe every empty candidate set as a clean working tree or as proof that every topic branch was merged.
- When candidates exist, preserve the full comparison ref and commit, candidate tips, exclusions, default-No confirmation, concurrency warning, recovery output, and exit behavior. Omit the routine message that no initialization was needed.
- Make `branch clean --help` a quick reference: usage, arguments, options, two examples, concise base and confirmation guidance, and the existing detailed safety-document link. Remove repeated purpose text, long safety/results sections, and the appended generic workspace-discovery explanation from this command only.
- Keep detailed safety, initialization, concurrency, exit-code, and recovery rules in the existing command and safety documentation.
- Add no flags and change no branch eligibility, preparation, Git mutation, selection, or error semantics.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `ai-submodule-workflow`: make cleanup plan details conditional on deletion candidates and define a concise cleanup help surface while retaining informed confirmation and fail-closed inspection.

## Impact

- Implementation targets: `scripts/lib/branch-clean.ts`, `scripts/lib/help.ts`, and the cleanup command's help composition in `scripts/oms.ts`.
- Verification targets: `tests/integration/branch-clean.test.ts` and the existing production journey in `tests/cli-branch-clean.test.js`; inspect actual bundled help rather than pinning prose snapshots.
- Documentation targets during implementation: `docs/commands.md`, `docs/how-oms-works.md`, and an English Changeset summary.
- No new dependencies, configuration, exported APIs, or persistence formats. Human-readable output changes intentionally; exit codes and Git safety remain unchanged.
- Planning dependency: `add-merged-branch-cleanup` is implemented but still active. Its cleanup requirements have not reached the main `ai-submodule-workflow` spec. This change's MODIFIED cleanup requirements use that change's delta as their baseline; synchronize that predecessor before synchronizing or archiving this change. Do not rewrite or archive the predecessor as part of this proposal.
