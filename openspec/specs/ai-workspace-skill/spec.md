# ai-workspace-skill Specification

## Purpose
Covers the installable `oms` workspace skills (a broad-trigger scope-decision skill plus per-workflow skills) and the `oms skills` command that guides users to install them.

## Requirements

### Requirement: Installable workspace skills
The repository SHALL publish the `oms` workspace skills under `skills/<name>/SKILL.md` so they are installable with the `skills` tool through the repository `skills/` source path.

#### Scenario: Skills are published at the repository skills root
- **WHEN** the repository is inspected
- **THEN** `skills/oms-workspace/SKILL.md`, `skills/oms-pointer/SKILL.md`, and `skills/oms-branch/SKILL.md` exist
- **AND** each file has YAML frontmatter with a `name` and a `description`

#### Scenario: Skills install through the scoped skills source
- **WHEN** a user runs `npx skills add divlook/oh-my-space/skills`
- **THEN** the three `oms` skills are available to install into the detected agent skill directories
- **AND** `npx skills add divlook/oh-my-space/skills --skill oms-workspace` installs only the broad-trigger skill
- **AND** `npx skills add divlook/oh-my-space/skills --list` lists exactly `oms-workspace`, `oms-pointer`, and `oms-branch` as the available `oms` skills
- **AND** the listed skills do not include repository-development skills from agent-specific directories such as `.opencode/skills/`, `.codex/skills/`, or `.claude/skills/`

### Requirement: Broad-trigger scope-guardrail skill
The `oms-workspace` skill SHALL instruct agents to establish workspace state and repository scope before Git work, rather than acting as a command router.

#### Scenario: Broad-trigger skill targets general workspace Git work
- **WHEN** the `oms-workspace` skill description is evaluated for relevance
- **THEN** it targets general, scope-ambiguous Git work in a workspace that contains `oms.yaml` — for example committing from the root, a moved `oms status` pointer, or a push
- **AND** it targets `oms sync`/`oms unsync` topology, which no per-workflow skill covers
- **AND** it does not restrict its trigger to enumerating `commit` or `branch` work, which the per-workflow skills own; overlap with those skills is acceptable because the agent loads every relevant skill rather than routing to one

#### Scenario: Broad-trigger skill instructs status-first scope discipline
- **WHEN** an agent loads the `oms-workspace` skill
- **THEN** the skill instructs running `oms status --json` before Git work involving `oms/`
- **AND** instructs deciding root versus `oms/<alias>` scope without guessing
- **AND** instructs never creating a root pointer commit unless the user explicitly asks

#### Scenario: Broad-trigger skill separates topology changes from pointer records
- **WHEN** an agent loads the `oms-workspace` skill
- **THEN** the skill instructs that adding or removing a repo stages the root topology (`.gitmodules` and the `oms/<alias>` gitlink), which `oms sync`/`oms unsync` commit with `--commit` — run non-interactively without `--commit`, the topology is left unstaged for the user to commit
- **AND** instructs that `oms record` records a moved pointer only and refuses adds and removals
- **AND** defers remaining flag detail to `oms sync --help` and `oms unsync --help`

### Requirement: Pointer-record workflow skill
The `oms-pointer` skill SHALL guide the cross-command flow of moving a submodule's commit (via `oms commit` or `oms pull`) and then recording the root pointer.

#### Scenario: Pointer skill description triggers on both commit and pull
- **WHEN** the `oms-pointer` skill description is evaluated for relevance
- **THEN** it names both `oms commit` and `oms pull` as triggers so the skill fires after either moves a submodule's commit

#### Scenario: Pointer skill sequences commit then record
- **WHEN** an agent loads the `oms-pointer` skill
- **THEN** the skill instructs committing submodule source changes with `oms commit -m "<message>"`, naming `-m` as required to create the commit
- **AND** instructs recording the moved root pointer with `oms record` afterward
- **AND** warns against committing the root pointer by mistake
- **AND** defers remaining flag detail to `oms commit --help` and `oms record --help`

#### Scenario: Pointer skill records after pull moves the pointer
- **WHEN** an agent loads the `oms-pointer` skill
- **THEN** the skill instructs that `oms pull` fast-forwarding a submodule also moves the root pointer
- **AND** instructs recording it with `oms record`, the same as after `oms commit`
- **AND** defers flag detail to `oms pull --help`

### Requirement: Branch workflow skill
The `oms-branch` skill SHALL guide branch selection and detached HEAD avoidance inside submodules.

#### Scenario: Branch skill distinguishes switch from checkout
- **WHEN** an agent loads the `oms-branch` skill
- **THEN** the skill instructs using `oms switch` to start a new local branch
- **AND** instructs using `oms checkout` to track an existing remote branch
- **AND** instructs avoiding detached HEAD
- **AND** defers flag detail to `oms switch --help` and `oms checkout --help`

### Requirement: Skills are self-sufficient and schema-stable
Each published skill SHALL carry the scope-guardrail kernel verbatim and avoid coupling to volatile detail, because skill firing is best-effort rather than guaranteed.

#### Scenario: Each skill carries the guardrail kernel verbatim
- **WHEN** any one `oms` skill is loaded without the others
- **THEN** it contains the canonical scope-guardrail kernel verbatim, stating that `oms status --json` should be run before Git work involving `oms/`, that each `oms/<alias>/` directory is a separate Git repository, that root versus submodule scope must not be guessed, and that a root pointer commit for an existing pointer move requires `oms record`
- **AND** the identical kernel text appears in the `oms/` marker block

#### Scenario: The guardrail kernel is single-sourced and drift-tested
- **WHEN** the project test suite runs
- **THEN** it asserts the guardrail kernel constant is a literal substring of the marker block and of each `SKILL.md`
- **AND** the build fails if any copy diverges

#### Scenario: Skills defer schema detail to authoritative sources
- **WHEN** a skill references `oms status --json`
- **THEN** the skill body, not its frontmatter, declares the `schemaVersion` it was written against
- **AND** it points to `oms status --help` for exact field semantics
- **AND** it instructs deferring to `oms status --help` when a *different* `schemaVersion` is observed

#### Scenario: Skill bodies stay portable
- **WHEN** a published skill body is inspected
- **THEN** it contains no agent-specific slash-command syntax

#### Scenario: Skills name only normal-path workflow flags
- **WHEN** a published skill body names a CLI flag
- **THEN** the flag is one required to complete the skill's normal workflow path — `oms commit -m`, or `oms sync`/`oms unsync --commit`
- **AND** selection flags, `--force`, and other non-normal-path flags are deferred to `oms <command> --help`
- **AND** the skill cites the relevant `oms <command> --help` alongside any flag it names

### Requirement: External skill installation command
The system SHALL provide `oms skills` to guide users toward installing the `oms` workspace skills through the repository `skills/` source path.

#### Scenario: Print skill installation commands
- **WHEN** the user runs `oms skills`
- **THEN** the command prints `npx skills add divlook/oh-my-space/skills` as the project-scope command to install the `oms` workspace skills
- **AND** prints `npx skills add divlook/oh-my-space/skills -g` as the global install command

#### Scenario: Delegate skill installation from the workspace root
- **WHEN** the user runs `oms skills --install` inside an `oms` workspace
- **THEN** the command resolves to the workspace root before delegating
- **AND** delegates to `npx skills add divlook/oh-my-space/skills`
- **AND** the command uses inherited stdio
- **AND** the command returns the delegated process exit code
- **AND** the command does not implement skill installation logic itself

#### Scenario: Install passes extra arguments through
- **WHEN** the user runs `oms skills --install` with extra arguments such as `-g` or `--skill oms-branch`
- **THEN** the extra arguments are forwarded verbatim to `npx skills add divlook/oh-my-space/skills`

#### Scenario: Install outside a workspace points to global install
- **WHEN** the user runs `oms skills --install` outside an `oms` workspace without `-g`
- **THEN** the command fails with a usage error
- **AND** points to `npx skills add divlook/oh-my-space/skills -g` for a global install

#### Scenario: Skill delegation failure gives manual command
- **WHEN** `oms skills --install` cannot execute the delegated command
- **THEN** the command reports the failure
- **AND** prints `npx skills add divlook/oh-my-space/skills` as the manual command to run

#### Scenario: Skill install command can be tested without real npx
- **WHEN** an internal test override such as `OMS_NPX_BIN` is set
- **AND** the user runs `oms skills --install` inside an `oms` workspace
- **THEN** the command delegates to the overridden executable with the same arguments that would be passed to `npx`
