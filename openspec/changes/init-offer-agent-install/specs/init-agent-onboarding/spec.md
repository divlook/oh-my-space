## ADDED Requirements

### Requirement: Interactive agent-instruction offer during init
After successfully scaffolding `oms.yaml`, `oms init` SHALL offer, in an interactive terminal, to install OMS agent instructions into `oms/AGENTS.md` and/or `oms/CLAUDE.md`, and SHALL install the managed block for the selected target using the existing `oms agent install` behavior.

#### Scenario: Init offers agent-instruction targets in an interactive terminal
- **WHEN** `oms init` creates `oms.yaml` in an interactive terminal
- **THEN** the command offers to install OMS agent instructions
- **AND** the choices include `oms/AGENTS.md`, `oms/CLAUDE.md`, `oms/AGENTS.md + oms/CLAUDE.md`, and a skip option

#### Scenario: Selecting a target installs the managed block
- **WHEN** the user selects `oms/AGENTS.md + oms/CLAUDE.md` at the init offer
- **THEN** the command creates `oms/AGENTS.md` and `oms/CLAUDE.md`
- **AND** each file contains one managed block delimited by `<!-- OMS START -->` and `<!-- OMS END -->`
- **AND** the command does not stage the files in Git

#### Scenario: Skipping the offer installs nothing
- **WHEN** the user chooses the skip option (or cancels the prompt) at the init offer
- **THEN** the command does not create `oms/AGENTS.md` or `oms/CLAUDE.md`
- **AND** `oms init` exits 0

#### Scenario: Force re-init offers on the same terms
- **WHEN** `oms init --force` overwrites an existing `oms.yaml` in an interactive terminal
- **THEN** the command offers the same agent-instruction install choices

### Requirement: Non-interactive init hints instead of prompting
In a non-interactive shell, `oms init` SHALL NOT prompt for agent instructions and SHALL instead print a hint to run `oms agent install`, without creating any instruction files.

#### Scenario: Non-interactive init prints a hint and writes no files
- **WHEN** `oms init` runs in a non-interactive shell
- **THEN** the command does not prompt for agent instructions
- **AND** the command prints a hint to run `oms agent install`
- **AND** the command does not create `oms/AGENTS.md` or `oms/CLAUDE.md`

### Requirement: Agent-instruction step is best-effort
`oms init` SHALL treat the agent-instruction step as best-effort: `oms.yaml` creation is the authoritative outcome, and an agent-install problem SHALL be surfaced as a warning without aborting init or changing its success result.

#### Scenario: oms.yaml creation success is independent of the agent step
- **WHEN** `oms init` creates `oms.yaml`
- **THEN** the command reports that `oms.yaml` was created
- **AND** the reported init success does not depend on whether agent instructions were installed

#### Scenario: Malformed existing markers warn without failing init
- **WHEN** the user selects an agent-instruction target during `oms init`
- **AND** the selected file already contains malformed OMS markers
- **THEN** the command warns that the agent instructions could not be installed
- **AND** the command does not modify the malformed file
- **AND** `oms init` still reports `oms.yaml` creation success
