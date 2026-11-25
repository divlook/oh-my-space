# Proposal

## Why

When a second computer initializes a registered repository, OMS checks out the commit recorded in the workspace root, even if the remote branch has advanced. Developers who want to share a repository list and work on their own branches instead have to switch or pull after setup and manage root pointers they do not need.

## What Changes

- **BREAKING**: Replace OMS-managed submodules with independent Git clones at `oms/<alias>/`. Share repository aliases, remotes, and baseline branches through `oms.yaml`, not source commits. Keep the workspace root under Git without tracking the managed clone directories; leave unrelated root files, agent instruction files, and non-OMS submodules alone.
- **BREAKING**: Replace `oms sync` and `oms unsync` with `oms clone` and `oms remove`, without compatibility aliases. Clone missing checkouts on the configured baseline branch or remote default. Keep existing independent checkouts unchanged when their origin matches the declaration after Git URL rewriting.
- If an alias is reused for a different repository, use only the current declaration to verify checkout identity. Preserve any mismatched checkout, even if it matches an older declaration.
- **BREAKING**: Make `oms remove` delete only verified local checkouts after confirmation, including checkouts whose former declarations can be verified in root history. Check the entire selection before deletion. Require current remote proof for commits reachable only through Git's reflog, even when the user confirms the single-alias exception for an inaccessible origin.
- **BREAKING**: Remove `oms record`, `autoCommitRegistration`, the old topology-commit flags, and root-pointer fields in status output. Update source commands, managed worktrees, and diagnostics to operate on independent clones.
- Provide explicit migration that removes only OMS-managed registrations and preserves local Git data and working files. Before updating the root on another computer, preview migration and safeguard local work. If that computer already has the shared conversion commit, verify the old registration in root history and recover only what remains. If ownership cannot be verified, preserve the data and report how to proceed.
- Make migration workspace-wide, with no alias selection. Check all migration targets before changing local or shared state. Use the recovery journal if application is interrupted.
- Target the next major release, `3.0.0`, through Changesets. Document how to upgrade and what changes for users who relied on pinned source versions. Implementation does not publish or move npm tags.

## Capabilities

### New Capabilities

- `workspace-source-migration`: Explicit conversion of legacy OMS submodules to independent clones, including preservation of local work and recovery guidance on each computer.

### Modified Capabilities

- `ai-submodule-workflow`: Replace the submodule-specific contract with independent source checkout lifecycle, status, and source commands; retire root registration and pointer recording.
- `ai-workspace-skill`: Remove pointer-recording guidance and update agent instructions and runtime compatibility for independent clones.
- `cli-automation-policy`: Apply preparation and consent rules to local clone provisioning rather than root registration.
- `init-onboarding`: Replace submodule setup guidance with the independent-clone setup path.
- `readme-onboarding`: Explain manifest-based sharing, independent checkouts, and the migration path.
- `release-channels`: Track the next major release through the existing Changesets and beta-to-stable workflow.
- `temporary-worktrees`: Attach managed worktrees to independent clones and preserve their repository and removal safeguards.
- `workspace-command-execution`: Validate independent canonical checkouts without preparing them or requiring submodule registration.
- `workspace-context`: Apply workspace and alias boundary checks to independent checkouts and keep root Git checks for migration.

## Impact

- CLI commands, help, manifest validation, root ignore rules, and the machine-readable status contract change. Scripts that record source pointers or parse pointer fields must be updated.
- An existing root revision no longer reproduces an exact combination of source commits after migration. Each computer controls its own branches and updates; migrating the shared root does not migrate another computer's local Git data.
- Update command documentation, onboarding, agent instructions and skills, migration verification, and release notes for the major version.
