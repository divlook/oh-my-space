## MODIFIED Requirements

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
