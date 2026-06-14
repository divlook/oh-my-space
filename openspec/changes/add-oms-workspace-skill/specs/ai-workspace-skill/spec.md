## ADDED Requirements

### Requirement: Installable workspace skills
The repository SHALL publish the `oms` workspace skills under `skills/<name>/SKILL.md` so they are installable with the `skills` tool.

#### Scenario: Skills are published at the repository skills root
- **WHEN** the repository is inspected
- **THEN** `skills/oms-workspace/SKILL.md`, `skills/oms-commit-record/SKILL.md`, and `skills/oms-branch/SKILL.md` exist
- **AND** each file has YAML frontmatter with a `name` and a `description`

#### Scenario: Skills install through the skills tool
- **WHEN** a user runs `npx skills add divlook/oh-my-space`
- **THEN** the three `oms` skills are available to install into the detected agent skill directories
- **AND** `npx skills add divlook/oh-my-space --skill oms-workspace` installs only the umbrella skill
- **AND** `npx skills add divlook/oh-my-space --list` lists the available `oms` skills

### Requirement: Umbrella scope-guardrail skill
The `oms-workspace` skill SHALL instruct agents to establish workspace state and repository scope before Git work, rather than acting as a command router.

#### Scenario: Umbrella targets workspace Git work
- **WHEN** the `oms-workspace` skill description is evaluated for relevance
- **THEN** it targets Git, commit, branch, push, and sync work in a workspace that contains `oms.yaml`

#### Scenario: Umbrella instructs status-first scope discipline
- **WHEN** an agent loads the `oms-workspace` skill
- **THEN** the skill instructs running `oms status --json` before Git work involving `oms/`
- **AND** instructs deciding root versus `oms/<alias>` scope without guessing
- **AND** instructs never creating a root pointer commit unless the user explicitly asks

### Requirement: Commit-record workflow skill
The `oms-commit-record` skill SHALL guide the cross-command flow of committing inside a submodule and then recording the root pointer.

#### Scenario: Commit-record skill sequences commit then record
- **WHEN** an agent loads the `oms-commit-record` skill
- **THEN** the skill instructs committing submodule source changes with `oms commit`
- **AND** instructs recording the moved root pointer with `oms record` afterward
- **AND** warns against committing the root pointer by mistake
- **AND** defers flag detail to `oms commit --help` and `oms record --help`

### Requirement: Branch workflow skill
The `oms-branch` skill SHALL guide branch selection and detached HEAD avoidance inside submodules.

#### Scenario: Branch skill distinguishes switch from checkout
- **WHEN** an agent loads the `oms-branch` skill
- **THEN** the skill instructs using `oms switch` to start a new local branch
- **AND** instructs using `oms checkout` to track an existing remote branch
- **AND** instructs avoiding detached HEAD
- **AND** defers flag detail to `oms switch --help` and `oms checkout --help`

### Requirement: Skills are self-sufficient and schema-stable
Each published skill SHALL carry the scope guardrail independently and avoid coupling to volatile detail, because skill firing is best-effort rather than guaranteed.

#### Scenario: Each skill restates the scope guardrail
- **WHEN** any one `oms` skill is loaded without the others
- **THEN** it still states that each `oms/<alias>/` directory is a separate Git repository
- **AND** it still instructs not guessing root versus submodule scope

#### Scenario: Skills defer schema detail to authoritative sources
- **WHEN** a skill references `oms status --json`
- **THEN** it declares an expected `schemaVersion: 1`
- **AND** it points to the README `status --json` section for exact field semantics
- **AND** it instructs checking documentation when a higher `schemaVersion` is observed

#### Scenario: Skill bodies stay portable
- **WHEN** a published skill body is inspected
- **THEN** it contains no agent-specific slash-command syntax

### Requirement: External skill installation command
The system SHALL provide `oms skills` to guide users toward installing the `oms` workspace skills.

#### Scenario: Print skill installation command
- **WHEN** the user runs `oms skills`
- **THEN** the command prints `npx skills add divlook/oh-my-space` as the command to install the `oms` workspace skills

#### Scenario: Delegate skill installation
- **WHEN** the user runs `oms skills --install`
- **THEN** the command delegates to `npx skills add divlook/oh-my-space`
- **AND** the command uses inherited stdio
- **AND** the command returns the delegated process exit code
- **AND** the command does not implement skill installation logic itself

#### Scenario: Skill delegation failure gives manual command
- **WHEN** `oms skills --install` cannot execute the delegated command
- **THEN** the command reports the failure
- **AND** prints `npx skills add divlook/oh-my-space` as the manual command to run

#### Scenario: Skill install command can be tested without real npx
- **WHEN** an internal test override such as `OMS_NPX_BIN` is set
- **AND** the user runs `oms skills --install`
- **THEN** the command delegates to the overridden executable with the same arguments that would be passed to `npx`
