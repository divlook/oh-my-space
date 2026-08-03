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
- **AND** each file has a frontmatter `metadata` block declaring an `author` and a `version`

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
- **THEN** the skill instructs using `oms branch switch` to start a new local branch
- **AND** instructs using `oms branch checkout` to track an existing remote branch
- **AND** instructs avoiding detached HEAD
- **AND** defers flag detail to `oms branch switch --help` and `oms branch checkout --help`

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

### Requirement: Skill OMS compatibility contract
Each published OMS skill SHALL declare the OMS runtime versions that support all instructions in that skill, independently from the skill's own content version.

#### Scenario: Published skill declares machine and human compatibility
- **WHEN** any published `skills/<name>/SKILL.md` frontmatter is parsed
- **THEN** `metadata.oh-my-space-version` is a quoted, valid semver range
- **AND** the standard Agent Skills `compatibility` field states the same OMS requirement for humans and agents
- **AND** build validation fails with the skill path and invalid field when either declaration is missing, malformed, or inconsistent

#### Scenario: Compatibility changes only with runtime dependencies
- **WHEN** a skill changes only its wording or other instructions already supported by its declared OMS range
- **THEN** its own `metadata.version` follows the skill bump policy
- **AND** `metadata.oh-my-space-version` remains unchanged

#### Scenario: Skill adopts newer CLI behavior
- **WHEN** a skill begins instructing behavior unavailable in its previously supported OMS versions
- **THEN** its own `metadata.version` is bumped
- **AND** `metadata.oh-my-space-version` is raised to the first prerelease or stable line that provides all instructed behavior

#### Scenario: Current main skills target the 1.0 line accurately
- **WHEN** the current OMS skills are prepared for the post-`0.14.2` command set
- **THEN** every skill is audited against the commands and semantics it describes
- **AND** a skill that depends on the new 1.0 command set declares a range beginning at `1.0.0-0`
- **AND** a skill that remains fully supported by an earlier OMS release retains that accurate earlier minimum rather than being raised solely for release uniformity

### Requirement: Runtime compatibility is evaluated independently
The CLI SHALL evaluate an installed skill's own version against the baked skill version and the running OMS package version against the installed skill's OMS semver range as independent dimensions.

#### Scenario: Newer skill remains runtime compatible
- **WHEN** an installed skill is newer than the baked copy
- **AND** the running OMS version satisfies the installed skill's `metadata.oh-my-space-version`
- **THEN** diagnostics SHALL NOT tell the user to update OMS merely because the skill is newer
- **AND** any reported freshness finding states that runtime compatibility is satisfied

#### Scenario: Installed skill requires a newer OMS runtime
- **WHEN** the running OMS version does not satisfy an installed skill's valid `metadata.oh-my-space-version`
- **THEN** diagnostics report the skill name, installed skill version, running OMS version, and required OMS range
- **AND** the incompatibility is reported even when the installed skill version matches the baked skill version

#### Scenario: Compatibility metadata cannot be verified
- **WHEN** an installed skill lacks a valid `metadata.oh-my-space-version`
- **THEN** diagnostics state that OMS compatibility could not be verified
- **AND** direct the user to update or reinstall the skill rather than claiming the CLI is incompatible

### Requirement: Channel-aware compatibility remediation
When an installed skill is incompatible with the running OMS version, the CLI SHALL identify an npm release channel that satisfies the declared range when registry channel information is available, without turning an informational skill finding into a command failure.

#### Scenario: Beta satisfies an upcoming 1.0 requirement
- **WHEN** a skill requires `>=1.0.0-0`
- **AND** npm `latest` does not satisfy the range
- **AND** npm `beta` resolves to a satisfying `1.0.0-beta.sha-<commit>` version
- **THEN** diagnostics print the package-manager-appropriate command for installing `oh-my-space@beta`

#### Scenario: Stable channel satisfies the requirement
- **WHEN** the running OMS version does not satisfy a skill range
- **AND** npm `latest` resolves to a version that satisfies it
- **THEN** diagnostics direct the user to the stable update path
- **AND** do not prefer beta over a satisfying stable release

#### Scenario: No published channel satisfies the requirement
- **WHEN** neither npm `latest` nor npm `beta` satisfies the installed skill's range
- **THEN** diagnostics report that no compatible published channel was found
- **AND** preserve the installed CLI and skill state

#### Scenario: Registry compatibility lookup fails
- **WHEN** registry channel metadata cannot be retrieved or parsed while diagnosing an incompatible skill
- **THEN** diagnostics still report the local version mismatch and required range
- **AND** provide explicit `@latest` and `@beta` inspection or installation guidance without claiming either channel satisfies the range
- **AND** the lookup failure does not change the command exit status

### Requirement: Baked skill version reference
The build SHALL derive each published skill's own version and OMS compatibility range from `skills/*/SKILL.md` and emit them into the build output so the CLI carries its own reference values without hand-maintained duplicates. When the reference is unavailable the CLI SHALL skip skill reporting silently.

#### Scenario: Build emits published skill references
- **WHEN** the CLI is built from the repository
- **THEN** the build reads `metadata.version` and `metadata.oh-my-space-version` from each published `SKILL.md`
- **AND** writes both values into the build metadata that ships with `dist/`

#### Scenario: Invalid source metadata fails the build
- **WHEN** a published skill has a malformed skill version, OMS semver range, or inconsistent human-readable compatibility declaration
- **THEN** the build fails and names the skill path and invalid field
- **AND** no partial skill reference is emitted

#### Scenario: Missing reference degrades to silence
- **WHEN** the baked skill references are absent because the build had no `skills/` directory
- **AND** the user runs a command that reports skills
- **THEN** the command reports nothing about skill freshness or compatibility
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
`oms doctor` SHALL report installed OMS skills whose own version differs from the baked reference, without treating a newer skill as proof that the running CLI is incompatible. The report SHALL be informational and SHALL NOT change the exit code, because it can reflect state outside the workspace.

#### Scenario: Older installed skill points at the skills tool
- **WHEN** an installed skill's `metadata.version` is lower than the baked reference
- **AND** the user runs `oms doctor`
- **THEN** doctor reports the skill name, installed version, current version, and scope
- **AND** names `npx skills update` with the affected skill names as the remediation

#### Scenario: Newer compatible installed skill avoids a false CLI update
- **WHEN** an installed skill's `metadata.version` is higher than the baked reference
- **AND** the running OMS version satisfies that skill's declared OMS range
- **THEN** doctor does not name `oms update` as required remediation
- **AND** keeps the freshness finding separate from any incompatible skill finding

#### Scenario: Missing or malformed skill version is treated as older
- **WHEN** an installed skill has no valid `metadata.version`
- **AND** the user runs `oms doctor`
- **THEN** doctor reports the installed skill version as unknown alongside the current reference
- **AND** names `npx skills update` as the remediation

#### Scenario: Installed but not located
- **WHEN** a lock entry records an installed OMS skill
- **AND** no installed `SKILL.md` is found for it
- **AND** the user runs `oms doctor`
- **THEN** doctor reports that the skill is recorded in the lock file but could not be located
- **AND** names `npx skills update` as the remediation

#### Scenario: Reporting is informational only
- **WHEN** doctor reports any skill freshness or compatibility finding
- **AND** no other warning is raised
- **THEN** the finding is emitted at informational level
- **AND** the warning count is not incremented
- **AND** doctor exits zero

#### Scenario: Matching and compatible skills are silent
- **WHEN** every installed OMS skill matches its baked skill version
- **AND** the running OMS version satisfies every installed skill's OMS range
- **THEN** doctor reports nothing about skills

### Requirement: Skill version reporting during self-update
`oms update` SHALL report skill freshness and runtime compatibility only where the running binary can answer them correctly. When the installed CLI is already current its baked references and running version are known; after the command upgrades the CLI, the old process SHALL point the user at `oms doctor` rather than claiming the newly installed runtime's compatibility. Reporting SHALL NOT change the exit code.

#### Scenario: Up-to-date CLI reports freshness and compatibility
- **WHEN** the user runs `oms update`
- **AND** the installed version already matches npm `latest`
- **THEN** the command reports installed skill freshness and OMS compatibility using the same independent classifications as `oms doctor`
- **AND** still reports that OMS is up to date
- **AND** exits zero

#### Scenario: After upgrading, defer to doctor
- **WHEN** `oms update` has successfully upgraded the CLI
- **AND** OMS skills are installed
- **THEN** the command reports that skills are installed and points at `oms doctor` to check freshness and compatibility
- **AND** does not claim to know whether the installed skills are current or compatible
- **AND** does not spawn the newly installed binary

#### Scenario: No skills installed keeps update output unchanged
- **WHEN** the user runs `oms update`
- **AND** no OMS skills are installed
- **THEN** the command output contains nothing about skills

