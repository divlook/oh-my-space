## MODIFIED Requirements

### Requirement: Installable workspace skills
The repository SHALL publish the `oms` workspace skills under `skills/<name>/SKILL.md` so they are installable with the `skills` tool through the repository `skills/` source path.

#### Scenario: Skills are published at the repository skills root
- **WHEN** the repository is inspected
- **THEN** `skills/oms-workspace/SKILL.md`, `skills/oms-pointer/SKILL.md`, and `skills/oms-branch/SKILL.md` exist
- **AND** each file has YAML frontmatter with a `name` and a `description`
- **AND** each file has a frontmatter `metadata` block declaring an `author` and a `version`

#### Scenario: Skills install through the scoped skills source
- **WHEN** a user runs `npx skills add divlook/oh-my-space/skills`
- **THEN** the three `oms` skills are available to install into the detected agent skill directories
- **AND** `npx skills add divlook/oh-my-space/skills --skill oms-workspace` installs only the broad-trigger skill
- **AND** `npx skills add divlook/oh-my-space/skills --list` lists exactly `oms-workspace`, `oms-pointer`, and `oms-branch` as the available `oms` skills
- **AND** the listed skills do not include repository-development skills from agent-specific directories such as `.opencode/skills/`, `.codex/skills/`, or `.claude/skills/`

## ADDED Requirements

### Requirement: Skill version marker
Each published skill SHALL declare its own version in the frontmatter `metadata` block as a quoted semver string, so an installed copy can be compared against the CLI that reads it. The version SHALL be per skill rather than shared across skills, and SHALL be a string rather than a number because the `skills` tool's `eve` install path preserves only string-valued `metadata` entries.

#### Scenario: Each skill declares a string semver version
- **WHEN** any published `SKILL.md` frontmatter is parsed
- **THEN** `metadata.version` is a non-empty string that is valid semver
- **AND** `metadata.author` identifies the publishing project
- **AND** the version is not expressed as a YAML number

#### Scenario: Versions are tracked independently per skill
- **WHEN** one skill's content changes and the others are untouched
- **THEN** only the changed skill's `metadata.version` moves
- **AND** the untouched skills keep their existing versions

#### Scenario: The version does not live in the skill body
- **WHEN** a published skill body is inspected
- **THEN** the body does not declare the skill's own version
- **AND** the body continues to declare the `oms status --json` `schemaVersion` it was written against

### Requirement: Skill version bump discipline
The repository SHALL define which semver component moves for a given kind of skill change, and the test suite SHALL fail when a skill's content changes without its `metadata.version` moving, so the marker cannot silently go stale.

#### Scenario: Bump policy is recorded
- **WHEN** the bump policy is consulted
- **THEN** a guardrail-kernel or scope-contract change requires a `major` bump
- **AND** an instruction or `description` change requires a `minor` bump
- **AND** a typo or wording change requires a `patch` bump

#### Scenario: Content change without a version bump fails the test suite
- **WHEN** a published skill's `name`, `description`, or body changes
- **AND** its `metadata.version` is unchanged
- **THEN** the test suite fails and names the skill and its current version

#### Scenario: The bump guard ignores the metadata block
- **WHEN** the content snapshot for a skill is computed
- **THEN** the frontmatter `metadata` block is excluded from the hashed content
- **AND** `name`, `description`, and the body are included
- **AND** bumping `metadata.version` alone does not change the hashed content

### Requirement: Baked skill version reference
The build SHALL derive the published skill versions from `skills/*/SKILL.md` and emit them into the build output so the CLI carries its own reference values without a hand-maintained duplicate. When the reference is unavailable the CLI SHALL skip skill version reporting silently.

#### Scenario: Build emits the published skill versions
- **WHEN** the CLI is built from the repository
- **THEN** the build reads `metadata.version` from each published `SKILL.md`
- **AND** writes those versions into the build metadata that ships with `dist/`

#### Scenario: Missing reference degrades to silence
- **WHEN** the baked skill versions are absent because the build had no `skills/` directory
- **AND** the user runs a command that reports skill versions
- **THEN** the command reports nothing about skill versions
- **AND** the command's exit code and other output are unaffected

### Requirement: Installed skill discovery
The system SHALL locate installed `oms` skills without assuming a single install layout, because the `skills` tool writes to different directories depending on how it was invoked. Discovery SHALL combine the tool's lock files, which record installation and origin but not the install path, with a shallow glob of agent skill directories, which finds the file but cannot establish origin. Either signal SHALL be sufficient to report; neither signal SHALL mean silence.

#### Scenario: Lock files are read for installation and origin
- **WHEN** skill discovery runs
- **THEN** it reads the global lock at the `skills` tool's home location, honouring an `XDG_STATE_HOME` override
- **AND** reads the project lock at the workspace root, and at the current directory when it differs
- **AND** treats a lock entry as an `oms` skill only when its recorded source is the `oms` repository

#### Scenario: Installed files are located by glob
- **WHEN** skill discovery searches for an installed `SKILL.md`
- **THEN** it matches one level of dot-directory under the user's home directory and under the workspace root
- **AND** finds copies installed into the tool's canonical directory as well as copies installed directly into an agent directory

#### Scenario: Unreadable or unrecognised lock degrades to the glob
- **WHEN** a lock file is missing, unparseable, or in a format whose entries cannot be interpreted
- **THEN** discovery does not fail
- **AND** discovery continues using the glob result alone
- **AND** a skill found only by glob is accepted on a name match, with origin unverified

#### Scenario: Skills that are not installed produce no output
- **WHEN** no lock entry and no installed file is found for any `oms` skill
- **THEN** nothing is reported about skill versions
- **AND** a partially installed set reports only on the skills that are present

### Requirement: Skill version drift diagnostics
`oms doctor` SHALL report installed `oms` skills whose version differs from the baked reference, naming the remediation command for the direction of the drift. The report SHALL be informational and SHALL NOT change the exit code, because it can reflect state outside the workspace.

#### Scenario: Older installed skill points at the skills tool
- **WHEN** an installed skill's `metadata.version` is lower than the baked reference
- **AND** the user runs `oms doctor`
- **THEN** doctor reports the skill name, the installed version, the current version, and the scope it was found in
- **AND** names `npx skills update` with the affected skill names as the remediation
- **AND** does not suggest a scope flag, because passing skill names already covers both scopes

#### Scenario: Newer installed skill points at the CLI update
- **WHEN** an installed skill's `metadata.version` is higher than the baked reference
- **AND** the user runs `oms doctor`
- **THEN** doctor reports that the installed skill is newer than the running `oms` knows
- **AND** names `oms update` as the remediation
- **AND** reports it separately from skills that are older than the reference

#### Scenario: Missing or malformed version is treated as older
- **WHEN** an installed skill has no `metadata.version`, or a value that is not valid semver
- **AND** the user runs `oms doctor`
- **THEN** doctor reports the installed version as unknown alongside the current version
- **AND** names `npx skills update` as the remediation

#### Scenario: Installed but not located
- **WHEN** a lock entry records an installed `oms` skill
- **AND** no installed `SKILL.md` is found for it
- **AND** the user runs `oms doctor`
- **THEN** doctor reports that the skill is installed but its version could not be verified
- **AND** names `npx skills update` as the remediation

#### Scenario: Reporting is informational only
- **WHEN** doctor reports any skill version finding
- **AND** no other warning is raised
- **THEN** the finding is emitted at informational level
- **AND** the warning count is not incremented
- **AND** doctor exits zero

#### Scenario: Matching versions are silent
- **WHEN** every installed `oms` skill matches the baked reference
- **AND** the user runs `oms doctor`
- **THEN** doctor reports nothing about skill versions

### Requirement: Skill version reporting during self-update
`oms update` SHALL report skill version drift only where the running binary can answer it correctly. When the installed CLI is already current its baked reference is the current reference, so the comparison SHALL be reported. After the command has upgraded the CLI, the running process cannot know the new reference, so it SHALL point the user at `oms doctor` instead of comparing. Reporting SHALL NOT change the exit code.

#### Scenario: Up-to-date CLI reports drift exactly
- **WHEN** the user runs `oms update`
- **AND** the installed version already matches the registry latest
- **THEN** the command reports any installed skill whose version differs from the baked reference, with its remediation command
- **AND** still reports that `oms` is up to date
- **AND** exits zero

#### Scenario: After upgrading, defer to doctor
- **WHEN** `oms update` has successfully upgraded the CLI
- **AND** `oms` skills are installed
- **THEN** the command reports that skills are installed and points at `oms doctor` to check whether they need updating
- **AND** does not claim to know whether the installed skills are current
- **AND** does not spawn the newly installed binary to compare versions

#### Scenario: No skills installed keeps update output unchanged
- **WHEN** the user runs `oms update`
- **AND** no `oms` skills are installed
- **THEN** the command's output contains nothing about skills
