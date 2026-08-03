## ADDED Requirements

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

## MODIFIED Requirements

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
