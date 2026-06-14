# ai-submodule-workflow Specification

## Purpose
TBD - created by archiving change improve-ai-submodule-workflow. Update Purpose after archive.
## Requirements
### Requirement: Machine-readable workspace status
The system SHALL provide `oms status --json` to report the root repository and configured submodules in a stable machine-readable format.

#### Scenario: Status JSON from workspace root
- **WHEN** the user runs `oms status --json` from the workspace root
- **THEN** stdout contains exactly one valid pretty-printed JSON object
- **AND** the object contains `schemaVersion`, `toolVersion`, `workspaceRoot`, `currentAlias`, `root`, `repos`, and `errors`
- **AND** stdout is formatted as two-space pretty JSON with a trailing newline
- **AND** stdout contains no non-JSON diagnostic text
- **AND** `currentAlias` is `null`
- **AND** `workspaceRoot` is an OS-native absolute path
- **AND** `errors` is an array

#### Scenario: JSON schema version allows additive fields
- **WHEN** consumers parse a `schemaVersion` 1 status payload
- **THEN** existing field names, meanings, and types are stable
- **AND** consumers may ignore additional optional fields added later under the same `schemaVersion`

#### Scenario: Status JSON from inside a submodule
- **WHEN** the user runs `oms status --json` from inside `oms/api/`
- **THEN** the command emits valid JSON
- **AND** `currentAlias` is `api`
- **AND** this remains true even when the configured submodule is not initialized

#### Scenario: Repo entries expose stable state fields
- **WHEN** the user runs `oms status --json`
- **THEN** each configured repo entry includes `alias`, `path`, `absolutePath`, `configured`, `initialized`, `branch`, `head`, `detached`, `trackingBranch`, `pin`, `dirty`, `changes`, `ahead`, `behind`, and `error`
- **AND** `path` is POSIX-style and workspace-relative
- **AND** `absolutePath` is OS-native and absolute
- **AND** `configured` indicates the alias exists in `oms.yaml` and does not mean the submodule is registered in `.gitmodules`
- **AND** `error` is `null` when the repo state was read successfully

#### Scenario: Dirty changes expose summary and counts
- **WHEN** the root repository or a configured repo has staged, unstaged, or untracked changes
- **THEN** its status object includes `dirty: true`
- **AND** its `changes` object includes numeric `staged`, `unstaged`, and `untracked` path counts based on `git status --porcelain=v1 -z`
- **AND** a path with both staged and unstaged changes contributes to both counts

#### Scenario: Root and submodule changes are separated
- **WHEN** a submodule has source changes or a moved gitlink
- **THEN** submodule source changes are reported in the matching `repos[].changes`
- **AND** root gitlink movement is reported in `root.submodulePointers`
- **AND** `root.changes` counts non-submodule root repository paths only

#### Scenario: Detached HEAD is represented explicitly
- **WHEN** the root repository or a configured repo is in detached HEAD
- **THEN** its `branch` is `null`
- **AND** its `detached` is `true`
- **AND** its `head` contains the current short SHA

#### Scenario: Missing tracking branch is represented explicitly
- **WHEN** a configured repo has no tracking branch
- **THEN** `trackingBranch`, `ahead`, and `behind` are `null`
- **AND** the command does not report ahead or behind as `0` merely because no comparison base exists

#### Scenario: Tracking branch divergence is numeric
- **WHEN** a configured repo has a tracking branch
- **THEN** `ahead` and `behind` are numbers
- **AND** `0` means the tracking comparison was successful with no commits on that side

#### Scenario: Recorded but uninitialized repo remains in inventory
- **WHEN** a configured repo has a recorded gitlink in the root repository HEAD but its working tree is not initialized
- **THEN** its repo entry remains present in `repos`
- **AND** `initialized` is `false`
- **AND** Git-dependent fields are `null` or safe defaults
- **AND** `pin` is `uninit`

#### Scenario: Missing root gitlink is represented
- **WHEN** a configured alias has no recorded gitlink in the root repository HEAD
- **THEN** `pin` is `missing`
- **AND** the human-readable `oms status` table also displays `missing`

#### Scenario: Never-synced repo reports missing rather than uninit
- **WHEN** a configured alias has no recorded gitlink in the root repository HEAD and no initialized working tree
- **THEN** `pin` is `missing`
- **AND** `pin` is not `uninit`

#### Scenario: Conflicted root gitlink is represented
- **WHEN** a configured alias has a conflicted root repository gitlink
- **THEN** `pin` is `conflict`
- **AND** the alias appears in `root.submodulePointers.conflict`
- **AND** the human-readable `oms status` table also displays `conflict`
- **AND** `oms status --json` exits 0 unless status collection itself fails

#### Scenario: Root submodule pointer state is exposed
- **WHEN** root repository submodule gitlinks are moved, staged, split between index and working tree, or conflicted
- **THEN** `root.submodulePointers` includes `moved`, `staged`, `split`, and `conflict` alias arrays
- **AND** an alias appears in `moved` when root repository HEAD differs from either the index pointer or working tree pointer
- **AND** an alias appears in `moved` when root repository HEAD has a gitlink but the working tree path has been removed by pending unsync topology changes
- **AND** an alias appears in `staged` when the index pointer differs from root repository HEAD
- **AND** an alias appears in `split` when it is staged (the index pointer differs from root repository HEAD) and the staged index pointer differs from the working tree pointer

#### Scenario: Partial status failure keeps JSON valid
- **WHEN** a repo state cannot be read
- **THEN** stdout still contains valid JSON with the normal repo entry shape
- **AND** unknown scalar repo fields are `null`
- **AND** structured fields such as `changes` preserve their normal object shape with safe default values
- **AND** the repo entry's `error` field contains a concise message
- **AND** top-level `errors` contains a matching summary
- **AND** the process exits non-zero

#### Scenario: Alias-filtered JSON status narrows repo and pointer arrays
- **WHEN** the user runs `oms status api --json`
- **THEN** `repos[]` includes only `api`
- **AND** `root.submodulePointers` arrays include only selected aliases
- **AND** repo-level `errors[]` entries and the exit code reflect only selected repos
- **AND** `root` status and `currentAlias` remain present

#### Scenario: Unknown status alias fails before JSON
- **WHEN** the user runs `oms status missing-alias --json`
- **THEN** the command fails with an invalid alias message on stderr
- **AND** stdout does not contain JSON

### Requirement: Current submodule alias resolution
The system SHALL resolve omitted aliases for supported one-alias commands using explicit arguments, current path inference, and interactive selection only.

#### Scenario: Alias inferred inside submodule tree
- **WHEN** the user runs a supported one-alias command without an alias from inside `oms/api/`
- **THEN** the command resolves alias `api`

#### Scenario: Alias inference uses path segment boundaries
- **WHEN** alias `api` exists and the current directory is `oms/api-extra/`
- **THEN** the command does not infer alias `api`

#### Scenario: Alias inferred before command preconditions
- **WHEN** the user runs `oms commit -m "feat: x"` from inside configured but uninitialized `oms/api/`
- **THEN** the command resolves alias `api`
- **AND** the command fails because `api` is not initialized
- **AND** the message suggests initializing or syncing the submodule

#### Scenario: Interactive candidate selection
- **WHEN** a supported one-alias command omits the alias outside any `oms/<alias>/` tree in an interactive terminal
- **THEN** the command builds a command-specific valid candidate list
- **AND** `oms commit` candidates are dirty submodules
- **AND** `oms record` candidates are moved submodule pointers, excluding pending removals

#### Scenario: Interactive single candidate auto-selects
- **WHEN** an interactive alias-less command has exactly one valid candidate
- **THEN** the command selects it automatically
- **AND** the command prints a short message explaining the selection

#### Scenario: Interactive no candidates is no-op
- **WHEN** an interactive alias-less `oms commit` has no dirty submodule candidates
- **THEN** the command reports that there is nothing to commit in any submodule
- **AND** exits 0
- **WHEN** an interactive alias-less `oms record` has no moved pointer candidates
- **THEN** the command reports that there is nothing to record for any submodule
- **AND** exits 0

#### Scenario: Non-interactive alias omission fails
- **WHEN** the user runs a supported one-alias command without an alias from outside any `oms/<alias>/` tree in a non-interactive shell
- **THEN** the command fails with a clear message explaining that an alias is required
- **AND** the command does not auto-select from dirty or moved state

### Requirement: Submodule-only commits
The system SHALL provide `oms commit <alias> -m <message>` to create commits only inside the selected submodule while respecting the submodule index for partial commits.

#### Scenario: Commit submodule changes only when nothing is staged
- **WHEN** the user runs `oms commit api -m "feat: add login flow"` and `oms/api/` has changed files but no staged changes
- **THEN** the command runs `git add -A` inside `oms/api/`
- **AND** the command creates a commit inside `oms/api/`
- **AND** the root repository does not receive a new commit
- **AND** unrelated root repository files are not staged
- **AND** the command prints the submodule short commit SHA
- **AND** the command prints the appropriate root follow-up hint, such as `oms record api` when an existing recorded gitlink is moved

#### Scenario: Commit staged submodule changes only
- **WHEN** `oms/api/` has staged changes and unstaged changes
- **AND** the user runs `oms commit api -m "feat: add login form"`
- **THEN** the command does not run `git add -A` inside `oms/api/`
- **AND** the command creates a commit inside `oms/api/` using only the staged changes
- **AND** the unstaged changes remain unstaged in `oms/api/`
- **AND** the command warns that unstaged changes remain uncommitted
- **AND** the root repository does not receive a new commit

#### Scenario: Commit supports multiple message paragraphs
- **WHEN** the user runs `oms commit api -m "feat: add login" -m "Add callback handling."`
- **THEN** both message paragraphs are passed to the submodule `git commit`

#### Scenario: Commit requires explicit message only for source commits
- **WHEN** `oms/api/` has committable source changes
- **AND** the user runs `oms commit api` without `-m`
- **THEN** the command fails without opening an editor
- **AND** the message explains that `-m` is required to create a submodule commit

#### Scenario: Commit no-op does not require a message
- **WHEN** `oms/api/` has no committable source changes
- **AND** the user runs `oms commit api` without `-m`
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** exits 0

#### Scenario: Commit without submodule changes
- **WHEN** the user runs `oms commit api -m "feat: add login flow"` and `oms/api/` has no committable changes
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** exits 0
- **AND** the command does not create a root repository commit

#### Scenario: Commit no-op with moved pointer
- **WHEN** `oms/api/` has no committable changes and the root pointer for `api` is moved
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** prints a hint to run `oms record api`
- **AND** does not record the root pointer

#### Scenario: Commit no-op with pending add topology
- **WHEN** `oms/api/` has no committable changes
- **AND** the root repository HEAD has no recorded gitlink for `oms/api`
- **AND** the working tree has an initialized `oms/api` submodule
- **AND** `.gitmodules` contains path `oms/api`
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command reports that there is nothing to commit for `api`
- **AND** prints a hint to run `oms sync api --commit`
- **AND** does not record the root pointer

#### Scenario: Commit rejects detached submodule HEAD
- **WHEN** `oms/api/` is in detached HEAD
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command fails
- **AND** suggests `oms switch api <branch>`
- **AND** does not modify the root repository

#### Scenario: Commit rejects in-progress Git operations
- **WHEN** `oms/api/` has a merge, rebase, cherry-pick, revert, bisect, or similar Git operation in progress
- **AND** the user runs `oms commit api -m "feat: add login flow"`
- **THEN** the command fails and instructs the user to resolve, continue, or abort the operation inside `oms/api/`
- **AND** does not modify the root repository

#### Scenario: Commit never records root pointer
- **WHEN** `oms commit api -m "feat: add login flow"` creates a submodule commit and the root pointer for `api` is moved
- **THEN** the command does not create a root repository pointer commit
- **AND** the command prints a hint to run `oms record api`

#### Scenario: Commit source changes with pending add topology
- **WHEN** `oms commit api -m "feat: add login flow"` creates a submodule commit
- **AND** the root repository HEAD has no recorded gitlink for `oms/api`
- **AND** the working tree has an initialized `oms/api` submodule
- **AND** `.gitmodules` contains path `oms/api`
- **THEN** the command does not create a root repository topology commit
- **AND** the command prints a hint to run `oms sync api --commit`

### Requirement: Explicit root pointer records
The system SHALL provide pointer-recording commands that commit only selected submodule gitlink updates in the root repository.

#### Scenario: Record moved submodule pointer
- **WHEN** `oms/api` points at a commit different from the root repository's recorded gitlink and the user runs `oms record api`
- **THEN** the command stages only `oms/api` in the root repository
- **AND** the command creates a root repository commit with message `chore(oms): update api submodule to <short-sha>`
- **AND** the command prints the root commit short SHA and commit message

#### Scenario: Record absent pointer movement
- **WHEN** `oms/api` does not differ from the root repository's recorded gitlink and the user runs `oms record api`
- **THEN** the command reports that there is no pointer update to record
- **AND** exits 0
- **AND** the command does not create a root repository commit

#### Scenario: Record no-op does not warn for dirty source changes
- **WHEN** `oms/api` has uncommitted source changes but no pointer movement
- **AND** the user runs `oms record api`
- **THEN** the command reports that there is no pointer update to record
- **AND** does not warn about dirty source changes

#### Scenario: Record fails for unrelated staged root repository changes
- **WHEN** the root repository index has staged paths other than exactly `oms/api`
- **AND** the user runs `oms record api`
- **THEN** the command fails with a message explaining that unrelated staged changes must be committed or unstaged first
- **AND** the command does not create a root repository commit

#### Scenario: Record allows unrelated unstaged root repository changes
- **WHEN** the root repository has unrelated unstaged changes
- **AND** no unrelated paths are staged
- **AND** the user runs `oms record api`
- **THEN** the command records only `oms/api`
- **AND** the unrelated unstaged changes remain uncommitted

#### Scenario: Record allows selected staged gitlink
- **WHEN** the only staged root repository path is `oms/api`
- **AND** the staged pointer matches the working tree pointer
- **AND** the user runs `oms record api`
- **THEN** the command creates the root pointer commit for `api`

#### Scenario: Record rejects staged pointer split
- **WHEN** the staged pointer for `oms/api` differs from the working tree pointer for `oms/api`
- **AND** the user runs `oms record api`
- **THEN** the command fails and asks the user to unstage or restage `oms/api`
- **AND** the command does not create a root repository commit

#### Scenario: Record rejects missing recorded gitlink
- **WHEN** the root repository has no recorded gitlink at `oms/api`
- **AND** the user runs `oms record api`
- **THEN** the command fails and explains that `record` only updates existing root gitlinks
- **AND** if pending add topology is detected, the message points to `oms sync api --commit`

#### Scenario: Record rejects conflicted root gitlink
- **WHEN** the root repository has a conflicted gitlink at `oms/api`
- **AND** the user runs `oms record api`
- **THEN** the command fails and asks the user to resolve the root repository conflict first

#### Scenario: Record rejects pending removal
- **WHEN** the root repository HEAD has a gitlink at `oms/api` but the working tree path `oms/api` has been removed
- **AND** the user runs `oms record api`
- **THEN** the command fails and explains that a pending submodule removal is recorded with `oms unsync api --commit`
- **AND** the command does not create a root repository commit
- **AND** the command does not stage the `oms/api` removal

#### Scenario: Record rejects root detached HEAD
- **WHEN** the root repository is in detached HEAD
- **AND** the user runs `oms record api`
- **THEN** the command fails and asks the user to switch the root repository to a branch first

#### Scenario: Record rejects root in-progress Git operation
- **WHEN** the root repository has a merge, rebase, cherry-pick, revert, bisect, or similar Git operation in progress
- **AND** the user runs `oms record api`
- **THEN** the command fails and asks the user to resolve, continue, or abort the root repository Git operation first

#### Scenario: Record warns for dirty submodule source changes
- **WHEN** `oms/api` has uncommitted source changes and a moved root pointer
- **AND** the user runs `oms record api`
- **THEN** the command warns that only the current HEAD pointer will be recorded
- **AND** the command records the root pointer

#### Scenario: Record commit failure preserves staged gitlink
- **WHEN** `oms record api` stages `oms/api`
- **AND** the root `git commit` step fails
- **THEN** the command fails
- **AND** the selected `oms/api` gitlink remains staged

### Requirement: Pull and push keep root pointer updates explicit
The system SHALL keep `oms pull` and `oms push` focused only on synchronizing submodules, while existing root gitlink pointer-update staging and commits are created only by `oms record <alias>`. Sync and unsync topology commits are a separate add/remove-submodule workflow.

#### Scenario: Sync leaves topology changes unstaged
- **WHEN** the user runs `oms sync api` without creating a topology commit and the command adds or updates root topology files such as `.gitmodules` or `oms/api`
- **THEN** those root working tree changes remain available for review
- **AND** the command does not leave those changes staged in the root index
- **AND** unrelated staged root changes remain staged
- **AND** the command prints guidance to review, stage, and commit root topology changes explicitly

#### Scenario: Unsync leaves topology changes unstaged
- **WHEN** the user runs `oms unsync api` without creating a topology commit and the command removes or updates root topology files such as `.gitmodules` or `oms/api`
- **THEN** those root working tree changes remain available for review
- **AND** the command does not leave those changes staged in the root index
- **AND** unrelated staged root changes remain staged
- **AND** the command prints guidance to review, stage, and commit root topology changes explicitly

#### Scenario: Interactive sync prompts for topology commit
- **WHEN** the user runs `oms sync api` in an interactive terminal and topology changes succeed
- **THEN** the command asks whether to create a root topology commit
- **AND** the prompt defaults to Yes and shows commit message `chore(oms): add api submodule`
- **AND** if the user accepts, the command creates a root commit with message `chore(oms): add api submodule`
- **AND** if the user declines, the command applies the path-limited unstage behavior

#### Scenario: Interactive unsync prompts for topology commit
- **WHEN** the user runs `oms unsync api` in an interactive terminal and topology changes succeed
- **THEN** the command asks whether to create a root topology commit
- **AND** the prompt defaults to Yes and shows commit message `chore(oms): remove api submodule`
- **AND** if the user accepts, the command creates a root commit with message `chore(oms): remove api submodule`
- **AND** if the user declines, the command applies the path-limited unstage behavior

#### Scenario: Topology commit prompt is driven by detected pending state
- **WHEN** a previous `oms sync api` or `oms unsync api` left pending topology without creating a topology commit
- **AND** the user later runs the same command again in an interactive terminal
- **THEN** the command detects the pending topology from root HEAD, working tree, and `.gitmodules` state
- **AND** asks again whether to create the root topology commit
- **AND** the prompt continues to re-appear until the topology change is committed or reverted

#### Scenario: Explicit sync commit bypasses prompt
- **WHEN** the user runs `oms sync api --commit`
- **THEN** the command creates a root topology commit with message `chore(oms): add api submodule`
- **AND** the command does not prompt

#### Scenario: Sync commit works for pending topology changes
- **WHEN** `oms sync api` previously created topology working tree changes without committing them
- **AND** the user later runs `oms sync api --commit`
- **AND** root HEAD has no `oms/api` gitlink, the working tree has initialized `oms/api`, and `.gitmodules` contains path `oms/api`
- **THEN** the command creates the root topology commit for the pending `api` topology changes

#### Scenario: Explicit unsync commit bypasses prompt
- **WHEN** the user runs `oms unsync api --commit`
- **THEN** the command creates a root topology commit with message `chore(oms): remove api submodule`
- **AND** the command does not prompt

#### Scenario: Unsync commit works for pending topology changes
- **WHEN** `oms unsync api` previously created topology working tree changes without committing them
- **AND** the user later runs `oms unsync api --commit`
- **AND** root HEAD has an `oms/api` gitlink and both the working tree path and `.gitmodules` entry for `oms/api` have been removed
- **THEN** the command creates the root topology commit for the pending `api` removal changes

#### Scenario: Unsync commit rejects partial removal topology
- **WHEN** root HEAD has an `oms/api` gitlink
- **AND** exactly one of the working tree path or `.gitmodules` entry for `oms/api` has been removed
- **AND** the current `oms unsync api --commit` invocation cannot complete the matching cleanup
- **THEN** the command fails without creating a topology commit
- **AND** the message explains that partial removal topology must be cleaned up before committing

#### Scenario: Multi-alias sync commit uses plural message
- **WHEN** the user runs `oms sync api web --commit`
- **THEN** the command creates one root topology commit when all requested aliases succeed
- **AND** the commit message is `chore(oms): add submodules`

#### Scenario: Multi-alias unsync commit uses plural message
- **WHEN** the user runs `oms unsync api web --commit`
- **THEN** the command creates one root topology commit when all requested aliases succeed
- **AND** the commit message is `chore(oms): remove submodules`

#### Scenario: Multi-alias topology commit is skipped on partial failure
- **WHEN** the user runs `oms sync api web --commit` or `oms unsync api web --commit`
- **AND** any requested alias fails
- **THEN** the command does not create a topology commit
- **AND** successfully changed topology paths are returned to unstaged state
- **AND** the final summary explains the manual review and commit follow-up

#### Scenario: Multi-alias topology prompt is skipped on partial failure
- **WHEN** the user runs `oms sync api web` or `oms unsync api web` in an interactive terminal
- **AND** any requested alias fails
- **THEN** the command does not ask whether to create a topology commit
- **AND** successfully changed topology paths are returned to unstaged state

#### Scenario: Topology commit rejects unrelated staged root changes
- **WHEN** the root index has staged paths unrelated to the selected sync or unsync topology paths
- **AND** the user accepts the topology commit prompt or passes `--commit`
- **THEN** the command fails before creating the topology commit
- **AND** the message asks the user to commit or unstage unrelated root changes first
- **AND** selected topology paths are returned to unstaged state

#### Scenario: Topology commit failure preserves staged paths
- **WHEN** sync or unsync stages selected topology paths for a topology commit
- **AND** the root `git commit` step fails
- **THEN** the command fails
- **AND** the selected topology paths remain staged

#### Scenario: Pull does not stage or commit the root gitlink
- **WHEN** the user runs `oms pull api`
- **THEN** the command pulls the current `api` submodule branch according to the existing fast-forward policy
- **AND** does not stage the root gitlink
- **AND** does not create a root repository commit

#### Scenario: Pull prints record hint when pointer moved
- **WHEN** the user runs `oms pull api` successfully and the root pointer for `api` is moved
- **THEN** the command prints a hint to run `oms record api`
- **AND** the command does not stage or record the root pointer

#### Scenario: Pull prints topology hint when recorded gitlink is missing
- **WHEN** the user runs `oms pull api` successfully
- **AND** root HEAD has no `oms/api` gitlink, the working tree has initialized `oms/api`, and `.gitmodules` contains path `oms/api`
- **THEN** the command prints a hint to run `oms sync api --commit`
- **AND** the command does not stage or record the root pointer

#### Scenario: Pull rejects dirty submodule source changes
- **WHEN** `oms/api` has uncommitted source changes
- **AND** the user runs `oms pull api`
- **THEN** the command fails before running pull
- **AND** the message asks the user to commit, stash, or clean changes inside `oms/api`

#### Scenario: Push does not stage or commit the root gitlink
- **WHEN** the user runs `oms push api`
- **THEN** the command pushes the current `api` submodule branch
- **AND** does not stage the root gitlink
- **AND** does not create a root repository commit

#### Scenario: Push prints record hint when pointer moved
- **WHEN** the user runs `oms push api` successfully and the root pointer for `api` is moved
- **THEN** the command prints a hint to run `oms record api`
- **AND** the command does not stage or record the root pointer

#### Scenario: Push prints topology hint when recorded gitlink is missing
- **WHEN** the user runs `oms push api` successfully
- **AND** root HEAD has no `oms/api` gitlink, the working tree has initialized `oms/api`, and `.gitmodules` contains path `oms/api`
- **THEN** the command prints a hint to run `oms sync api --commit`
- **AND** the command does not stage or record the root pointer

#### Scenario: Push warns for dirty submodule source changes
- **WHEN** `oms/api` has uncommitted source changes
- **AND** the user runs `oms push api`
- **THEN** the command warns that only the current HEAD will be pushed
- **AND** the command does not auto-commit source changes

#### Scenario: Push rejects detached submodule HEAD
- **WHEN** `oms/api` is in detached HEAD
- **AND** the user runs `oms push api`
- **THEN** the command fails and suggests `oms switch api <branch>`
- **AND** the command does not stage or commit the root gitlink

#### Scenario: Pull rejects detached submodule HEAD
- **WHEN** `oms/api` is in detached HEAD
- **AND** the user runs `oms pull api`
- **THEN** the command fails and suggests `oms switch api <branch>`
- **AND** the command does not stage or commit the root gitlink

#### Scenario: Multi-alias pull and push process aliases independently
- **WHEN** the user runs `oms push api web` or `oms pull api web`
- **THEN** the command processes aliases independently
- **AND** continues processing later aliases after one alias fails
- **AND** exits non-zero if any alias operation fails
- **AND** prints a final summary of per-alias results

#### Scenario: Push record option is unsupported
- **WHEN** the user runs `oms push api --record`
- **THEN** the command fails before pushing
- **AND** the message explains that existing root pointer updates are committed with `oms record api`

#### Scenario: Removed push commit option fails before pushing
- **WHEN** the user runs `oms push api --commit`
- **THEN** the command fails before pushing
- **AND** the message explains that submodule branches are pushed with `oms push api` and root pointer updates are committed with `oms record api`
- **AND** does not create a root repository commit

### Requirement: Managed agent instruction files
The system SHALL manage AI agent instruction blocks in selected files under the workspace `oms/` directory.

#### Scenario: Install selected agent instruction files
- **WHEN** the user runs `oms agent install --target both`
- **THEN** the command creates or updates `oms/AGENTS.md` and `oms/CLAUDE.md`
- **AND** each file contains one managed block delimited by `<!-- OMS START -->` and `<!-- OMS END -->`
- **AND** the command does not stage the files in Git

#### Scenario: Interactive install target selection
- **WHEN** the user runs `oms agent install` in an interactive terminal without `--target`
- **THEN** the command offers `AGENTS.md`, `CLAUDE.md`, and `AGENTS.md + CLAUDE.md` choices

#### Scenario: Non-interactive install requires target
- **WHEN** the user runs `oms agent install` in a non-interactive shell without `--target`
- **THEN** the command fails and asks for `--target agents|claude|both`

#### Scenario: Preserve existing file content
- **WHEN** a selected instruction file already exists without an OMS managed block and the user runs `oms agent install --target agents`
- **THEN** the command appends the OMS managed block after two blank lines
- **AND** the command preserves existing content outside the managed block
- **AND** the resulting file ends with one trailing newline

#### Scenario: Replace existing managed block
- **WHEN** a selected instruction file already contains exactly one complete OMS managed block and the user runs `oms agent install --target agents`
- **THEN** the command replaces only the managed block
- **AND** preserves all content outside the managed block

#### Scenario: Reject malformed markers atomically
- **WHEN** any selected instruction file contains malformed OMS markers
- **AND** the user runs `oms agent install --target both`
- **THEN** the command fails with a message explaining that the managed block markers are malformed
- **AND** no selected file is modified

#### Scenario: Uninstall managed block
- **WHEN** a selected instruction file contains exactly one complete OMS managed block and the user runs `oms agent uninstall --target agents`
- **THEN** the command removes only the OMS managed block
- **AND** preserves all content outside the managed block

#### Scenario: Uninstall deletes empty managed file
- **WHEN** removing the OMS managed block leaves the target file empty or whitespace-only
- **THEN** the command deletes the target file

#### Scenario: Uninstall no-op for missing block
- **WHEN** the selected instruction file is missing or contains no OMS managed block
- **AND** the user runs `oms agent uninstall --target agents`
- **THEN** the command exits 0 and reports that no OMS block was found

#### Scenario: Uninstall rejects malformed markers atomically
- **WHEN** any selected instruction file contains malformed OMS markers
- **AND** the user runs `oms agent uninstall --target both`
- **THEN** the command fails with no selected file modifications

### Requirement: Agent instruction content
The managed agent instruction block SHALL provide concise durable rules and defer detailed usage to CLI help.

#### Scenario: Installed instructions describe minimal safe OMS workflow
- **WHEN** the user runs `oms agent install --target agents`
- **THEN** the managed block instructs agents to run `oms status --json` before Git work involving `oms/`
- **AND** the managed block explains that `oms/<alias>/` directories are separate Git repositories
- **AND** the managed block instructs agents not to guess root repository versus submodule Git scope
- **AND** the managed block states that root repository commits for existing submodule pointer updates must not be created unless the user explicitly runs `oms record <alias>`
- **AND** the managed block points agents to `oms --help` and `oms <command> --help` for exact command usage

### Requirement: CLI help documents new workflow boundaries
The system SHALL provide help output for new or changed commands that describes purpose, scope, and at least one usage example.

#### Scenario: Help explains scoped commit and record behavior
- **WHEN** the user runs help for `oms commit` or `oms record`
- **THEN** the help text explains which repository the command mutates
- **AND** the help text includes an example command

#### Scenario: Help explains push and record separation
- **WHEN** the user runs help for `oms push`
- **THEN** the help text explains that pull and push do not stage or commit the root gitlink
- **AND** the help text identifies `--commit` as unsupported and points to `oms record <alias>`
- **AND** the help text distinguishes staging for review from recording a root pointer commit

