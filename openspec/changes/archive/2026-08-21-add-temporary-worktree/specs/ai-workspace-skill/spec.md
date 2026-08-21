# Delta: ai-workspace-skill

## MODIFIED Requirements

### Requirement: Broad-trigger scope-guardrail skill

The `oms-workspace` skill SHALL instruct agents to establish workspace state and repository scope before Git work, rather than acting as a command router. For work inside a managed tree under `.oms-tree/`, the skill SHALL instruct agents to use Git directly, to push and open a pull request from the tree, and to reflect a merged result in the canonical checkout with `oms pull` followed by `oms record`, rather than running `oms` alias commands from inside the tree.

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

#### Scenario: Broad-trigger skill explains managed-tree scope

- **WHEN** an agent loads the `oms-workspace` skill
- **THEN** the skill instructs using Git directly inside a managed tree under `.oms-tree/` and not running `oms` alias commands from there
- **AND** instructs pushing and opening a pull request from the tree, then reflecting the merged result in the canonical checkout with `oms pull` followed by `oms record`
- **AND** defers remaining tree detail to `oms tree --help`

### Requirement: Branch workflow skill

The `oms-branch` skill SHALL guide branch selection and detached HEAD avoidance inside submodules. For starting a task that needs its own checkout of a source repository, the skill SHALL instruct creating a managed tree with `oms tree add <alias> <task>` instead of switching the canonical checkout away from its current branch.

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
