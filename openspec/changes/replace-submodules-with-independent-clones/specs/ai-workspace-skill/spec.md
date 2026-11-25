# Spec Delta

## ADDED Requirements

### Requirement: Installable independent checkout skills
OMS SHALL publish the workspace and branch skills under `skills/<name>/SKILL.md` and SHALL no longer publish `oms-pointer` as a current skill.

#### Scenario: Supported skills remain installable
- **WHEN** a user lists skills from the official skills source
- **THEN** the list contains `oms-workspace` and `oms-branch` but not `oms-pointer`, and each current skill can still be installed by name

### Requirement: Scope guardrails for independent checkout skills
The workspace skill SHALL direct agents to inspect workspace status and choose the intended root or independent source before Git work. It SHALL explain that source commits and pushes do not require root pointer steps.

#### Scenario: Agent works across repository boundaries
- **WHEN** an agent reads the workspace skill before scoped Git work
- **THEN** the skill directs the agent to `oms status --json`, to the selected checkout for source work, and to plain Git inside managed trees

#### Scenario: Merged task is reflected locally
- **WHEN** a task branch merges on the remote
- **THEN** the skill directs the agent to update the canonical source explicitly without recording a pointer in the root

### Requirement: Skill guardrail and status schema alignment
Each published OMS skill SHALL carry the same scope guardrails as the managed instruction block, state the supported status JSON schema in its body, and defer volatile command details to help.

#### Scenario: Independent source guardrails are consistent
- **WHEN** a user reads a published OMS skill or generated managed instructions
- **THEN** each describes the same status-first, root-versus-source boundary and no current instruction requires recording a root pointer

#### Scenario: Existing guidance and portability are retained
- **WHEN** a skill names CLI commands or consumes status JSON
- **THEN** it is portable across agents, directs readers to version-matched CLI help, and names only necessary normal-path flags

### Requirement: OMS runtime compatibility for workspace skills
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

#### Scenario: Skills using independent clone semantics require a compatible runtime
- **WHEN** a published skill relies on the new source checkout or status contract
- **THEN** its compatibility declarations exclude older OMS releases without that behavior and its content version follows the existing bump rules

## MODIFIED Requirements

### Requirement: Branch workflow skill
The `oms-branch` skill SHALL guide branch selection and detached HEAD avoidance inside source repositories. For starting a task that needs its own checkout of a source repository, the skill SHALL instruct creating a managed tree with `oms tree add <alias> <task>` instead of switching the canonical checkout away from its current branch.

#### Scenario: Branch skill distinguishes switch from checkout
- **WHEN** an agent loads the `oms-branch` skill
- **THEN** the skill instructs using `oms branch switch` to start a new local branch
- **AND** instructs using `oms branch checkout` to track an existing remote branch
- **AND** instructs avoiding detached HEAD
- **AND** defers flag detail to `oms branch switch --help` and `oms branch checkout --help`

#### Scenario: Branch skill starts task work in a managed tree
- **WHEN** an agent starts task work that needs an isolated checkout of a source repository
- **THEN** the skill instructs creating one with `oms tree add <alias> <task>` instead of switching the canonical checkout
- **AND** defers flag detail to `oms tree add --help`

## REMOVED Requirements

### Requirement: Pointer-record workflow skill
**Reason**: The source workflow no longer has a root pointer to record.
**Migration**: Use the workspace skill for repository scope and commit or push only in the intended repository.

### Requirement: Installable workspace skills
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Installable independent checkout skills.

### Requirement: Broad-trigger scope-guardrail skill
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Scope guardrails for independent checkout skills.

### Requirement: Skills are self-sufficient and schema-stable
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, Skill guardrail and status schema alignment.

### Requirement: Skill OMS compatibility contract
**Reason**: The independent checkout model replaces this contract and its legacy scenarios.
**Migration**: See the replacement requirement, OMS runtime compatibility for workspace skills.

