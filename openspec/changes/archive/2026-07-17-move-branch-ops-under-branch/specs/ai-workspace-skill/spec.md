## MODIFIED Requirements

### Requirement: Branch workflow skill
The `oms-branch` skill SHALL guide branch selection and detached HEAD avoidance inside submodules.

#### Scenario: Branch skill distinguishes switch from checkout
- **WHEN** an agent loads the `oms-branch` skill
- **THEN** the skill instructs using `oms branch switch` to start a new local branch
- **AND** instructs using `oms branch checkout` to track an existing remote branch
- **AND** instructs avoiding detached HEAD
- **AND** defers flag detail to `oms branch switch --help` and `oms branch checkout --help`
