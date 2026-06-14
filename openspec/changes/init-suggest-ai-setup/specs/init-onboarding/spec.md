## ADDED Requirements

### Requirement: Init surfaces optional AI-setup guidance
After successfully scaffolding `oms.yaml`, `oms init` SHALL print optional guidance that points to both AI-setup commands — `oms agent install` and `oms skills` — without installing anything itself. The guidance SHALL be output-only and SHALL NOT change `oms init`'s success result, which remains `oms.yaml` creation.

#### Scenario: Init points to both AI-setup commands
- **WHEN** `oms init` creates `oms.yaml`
- **THEN** the output includes guidance to run `oms agent install`
- **AND** the output includes guidance to run `oms skills` (to install the workspace skills)
- **AND** `oms init` exits 0

#### Scenario: Init installs nothing while printing the guidance
- **WHEN** `oms init` creates `oms.yaml`
- **THEN** the command does not create `oms/AGENTS.md` or `oms/CLAUDE.md`
- **AND** the command does not run the skills installer

#### Scenario: Guidance is identical in a non-interactive shell
- **WHEN** `oms init` runs in a non-interactive shell
- **THEN** the command does not prompt
- **AND** the output still includes guidance to run `oms agent install` and `oms skills`

#### Scenario: Force re-init prints the same guidance
- **WHEN** `oms init --force` overwrites an existing `oms.yaml`
- **THEN** the output includes the same AI-setup guidance
- **AND** the command still reports that `oms.yaml` was created
