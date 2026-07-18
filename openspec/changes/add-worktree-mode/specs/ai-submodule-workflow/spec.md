## MODIFIED Requirements

### Requirement: Machine-readable workspace status
The system SHALL provide `oms status --json` schema version 2 as one stable, mode-aware machine-readable workspace contract. Repository-root `oms.status.schema.json` SHALL be the normative contract for every field name, type, required or optional status, nullability, discriminator, enum, and structured error shape; exported TypeScript status types SHALL match it. The payload SHALL discriminate submodule and worktree repository state, represent an optional enclosing Git root, and preserve valid JSON with structured errors when individual repository or worktree inspection fails.

#### Scenario: Schema and TypeScript contracts stay aligned
- **WHEN** status contract tests run
- **THEN** representative submodule, worktree, nullable-root, filtered, and partial-error payloads validate against `oms.status.schema.json`
- **AND** compile-time fixtures prove producers and consumers use the matching exported TypeScript discriminated union
- **AND** drift in field names, types, required status, nullability, enums, or error shapes fails the test suite

#### Scenario: Status JSON has stable top-level fields
- **WHEN** the user runs `oms status --json`
- **THEN** stdout contains exactly one two-space pretty-printed JSON object with a trailing newline
- **AND** contains `schemaVersion`, `toolVersion`, `mode`, `workspaceRoot`, `currentAlias`, `currentWorktree`, `currentTarget`, `root`, `repos`, and `errors`
- **AND** `schemaVersion` is 2
- **AND** stdout contains no diagnostic text outside the JSON object

#### Scenario: Schema version 2 is mode-discriminated
- **WHEN** consumers parse a schema version 2 payload
- **THEN** every repo entry has common identity fields and a mode discriminator
- **AND** submodule-only and worktree-only fields appear only in their applicable mode shape
- **AND** additive optional fields may be ignored under the same schema version
- **AND** changing or removing existing field names, meanings, or types requires another schema version

#### Scenario: Current submodule context
- **WHEN** status runs inside configured submodule `oms/api/`
- **THEN** `currentAlias` is `api`
- **AND** `currentWorktree` and `currentTarget` are null

#### Scenario: Current managed worktree context
- **WHEN** status runs inside managed worktree `oms/api/login/`
- **THEN** `currentAlias` is `api`
- **AND** `currentWorktree` is `login`
- **AND** `currentTarget` is `api/login`

#### Scenario: Root is absent outside Git
- **WHEN** a worktree workspace is outside any enclosing Git repository
- **THEN** `root` is null
- **AND** repository and worktree status remains available

#### Scenario: Enclosing root relationship is explicit
- **WHEN** a worktree workspace equals or is nested below an enclosing Git top-level
- **THEN** root contains its OS-native absolute path and relation to the workspace
- **AND** root branch, HEAD, detached state, dirty state, and change counts describe the complete enclosing repository
- **AND** generated `.oms/` and managed worktree paths do not inflate root change counts

#### Scenario: Submodule root pointer state remains explicit
- **WHEN** mode is submodule
- **THEN** root exposes moved, staged, split, and conflicted submodule pointer arrays
- **AND** repo entries expose `pin` values `ok`, `moved`, `uninit`, `missing`, or `conflict`
- **AND** root non-pointer change counts exclude configured and registered gitlink paths

#### Scenario: Worktree mode omits pointer concepts
- **WHEN** mode is worktree
- **THEN** root omits `submodulePointers`
- **AND** repo and worktree entries omit `pin`
- **AND** no empty pointer structure implies that worktree revisions are parent-recorded

#### Scenario: Submodule repo shape remains complete
- **WHEN** mode is submodule
- **THEN** each configured repo includes alias, workspace-relative and absolute paths, configured and initialized state, branch, HEAD, detached state, tracking branch, pin, dirty state, change counts, ahead, behind, and error

#### Scenario: Worktree repo shape separates common and checkout state
- **WHEN** mode is worktree
- **THEN** each configured repo includes alias, common-repository paths and readiness, remote summary, `worktrees`, and error
- **AND** each managed worktree includes `managed: true`, portable name, `alias/name` target, paths, branch, HEAD, detached state, tracking, dirty counts, divergence, lock state, operation state, and error

#### Scenario: External worktree shape is explicit
- **WHEN** a common repository registers a linked worktree outside OMS managed paths
- **THEN** its worktree entry has `managed: false`, `name: null`, `target: null`, and an absolute path
- **AND** includes readable branch, HEAD, dirty, lock, operation, and error state

#### Scenario: Repo with no worktrees remains in inventory
- **WHEN** a configured worktree-mode common repository has no linked worktrees
- **THEN** its repo entry remains in `repos`
- **AND** `worktrees` is an empty array
- **AND** human status emits an alias-level row showing no worktrees

#### Scenario: Dirty changes expose counts
- **WHEN** an enclosing root, submodule, or linked worktree has staged, unstaged, or untracked changes
- **THEN** its state includes `dirty: true`
- **AND** numeric staged, unstaged, and untracked path counts parsed from NUL-delimited porcelain status
- **AND** a path changed in both index and working tree contributes to both applicable counts

#### Scenario: Detached and missing tracking state are explicit
- **WHEN** an inspected Git worktree is detached
- **THEN** branch is null, detached is true, and HEAD contains the short SHA
- **AND** when no tracking branch exists, tracking branch, ahead, and behind are null rather than zero

#### Scenario: Tracking divergence is numeric
- **WHEN** a tracking branch can be compared
- **THEN** ahead and behind are numbers including zero

#### Scenario: Partial submodule failure keeps normal shape
- **WHEN** a submodule state cannot be read
- **THEN** its repo entry remains with safe scalar defaults and structured change defaults
- **AND** repo error and top-level errors include the failure
- **AND** status exits 2

#### Scenario: Partial worktree failure keeps normal shape
- **WHEN** a managed or external worktree state cannot be read
- **THEN** its worktree entry remains in the owning repo with safe defaults
- **AND** worktree error, repo error summary, and top-level errors identify the failure
- **AND** status exits 2

#### Scenario: Alias filter selects a repository
- **WHEN** the user runs `oms status api --json`
- **THEN** repos contains only alias `api` and all its applicable checkout state
- **AND** root and current context remain present
- **AND** selected errors determine the exit code

#### Scenario: Compound filter selects one worktree
- **WHEN** the user runs `oms status api/login --json` in worktree mode
- **THEN** repos contains only `api`
- **AND** its worktrees array contains only managed target `api/login`
- **AND** root and current context remain present

#### Scenario: Invalid filter fails before JSON
- **WHEN** a status alias or compound target is unknown or invalid for the current mode
- **THEN** status exits 1 with a diagnostic on stderr
- **AND** stdout contains no JSON
