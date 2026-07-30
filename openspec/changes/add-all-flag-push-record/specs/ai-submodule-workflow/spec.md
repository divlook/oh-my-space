## MODIFIED Requirements

### Requirement: Current submodule alias resolution
The system SHALL resolve omitted alias selection for supported alias commands using explicit arguments, current path inference, and interactive selection only. A supported one-alias command (`oms commit`) SHALL resolve to at most one alias. A supported multi-alias command (`oms record`) SHALL resolve to a set of aliases and SHALL treat an explicit alias list or `--all` as the explicit argument that suppresses current path inference.

#### Scenario: Alias inferred inside submodule tree
- **WHEN** the user runs a supported alias command without an alias from inside `oms/api/`
- **THEN** the command resolves alias `api`

#### Scenario: Alias inference uses path segment boundaries
- **WHEN** alias `api` exists and the current directory is `oms/api-extra/`
- **THEN** the command does not infer alias `api`

#### Scenario: Alias inferred before command preconditions
- **WHEN** the user runs `oms commit -m "feat: x"` from inside configured but uninitialized `oms/api/`
- **THEN** the command resolves alias `api`
- **AND** the command fails because `api` is not initialized
- **AND** the message suggests initializing or syncing the submodule

#### Scenario: Explicit whole-workspace selection suppresses inference
- **WHEN** the user runs `oms record --all` from inside `oms/api/`
- **THEN** the command does not narrow the selection to the inferred alias `api`
- **AND** the command selects every declared repo

#### Scenario: Interactive candidate selection
- **WHEN** a supported alias command omits the alias outside any `oms/<alias>/` tree in an interactive terminal
- **THEN** the command builds a command-specific valid candidate list
- **AND** `oms commit` candidates are dirty submodules, presented as a single-select choice
- **AND** `oms record` candidates are moved submodule pointers that record can actually commit, excluding pending removals and staged pointer splits, presented as a multi-select choice
- **AND** the candidate filter is derived from the same recordability judgement `oms record` enforces, so the picker never offers an alias that recording would refuse

#### Scenario: Interactive single candidate auto-selects
- **WHEN** an interactive alias-less command has exactly one valid candidate
- **THEN** the command selects it automatically
- **AND** the command prints a short message explaining the selection

#### Scenario: Interactive no candidates is no-op
- **WHEN** an interactive alias-less `oms commit` has no dirty submodule candidates
- **THEN** the command reports that there is nothing to commit in any submodule
- **AND** exits 0
- **WHEN** an interactive alias-less `oms record` has no moved pointer candidates
- **THEN** the command reports that there is nothing to record for any submodule
- **AND** exits 0

#### Scenario: Non-interactive alias omission fails
- **WHEN** the user runs a supported alias command without an alias from outside any `oms/<alias>/` tree in a non-interactive shell
- **THEN** the command fails with a clear message explaining that an alias is required
- **AND** for a multi-alias command the message names `--all` as the whole-workspace alternative
- **AND** the command does not auto-select from dirty or moved state

### Requirement: Guarded deterministic prompt responses
The system SHALL expose deterministic prompt responses only when `OMS_TEST_MODE=1` and `OMS_TEST_PROMPT_RESPONSES` are both set, without changing normal interactive behavior.

#### Scenario: Typed test responses drive prompts
- **WHEN** `OMS_TEST_MODE=1` and `OMS_TEST_PROMPT_RESPONSES` contains a JSON array
- **THEN** each entry is one of `{"type":"select","value":"..."}`, `{"type":"confirm","value":true|false}`, `{"type":"multiselect","values":["...", "..."]}`, or `{"type":"cancel"}`
- **AND** the queue supplies responses in prompt order even when stdin is not a TTY
- **AND** no real prompt is opened

#### Scenario: Multi-select responses supply an ordered value list
- **WHEN** a `multiselect` entry is consumed for a multi-select prompt
- **THEN** the command receives the entry's `values` array as the selected set
- **AND** an entry whose `values` is not an array of strings fails closed

#### Scenario: Invalid test response configuration fails closed
- **WHEN** the queue JSON is malformed, an entry has an unknown shape, its type does not match the next prompt, or responses remain at command completion
- **THEN** the command exits 1 without falling back to a real prompt

#### Scenario: Prompt injection is disabled normally
- **WHEN** either `OMS_TEST_MODE=1` or `OMS_TEST_PROMPT_RESPONSES` is absent
- **THEN** the command ignores injected responses
- **AND** uses normal TTY detection and prompt behavior

## ADDED Requirements

### Requirement: Whole-workspace selection for submodule-set commands
The system SHALL accept an optional alias list and a `--all` flag on `oms push` and `oms record`, matching the selection model already provided by `oms sync`, `oms status`, `oms fetch`, `oms pull`, and `oms unsync`. `--all` SHALL select every repo declared in the selected manifest without prompting. For the prompting set commands — `oms sync`, `oms fetch`, `oms pull`, `oms push`, and `oms unsync` — an omitted alias list SHALL resolve through interactive selection in an interactive terminal and SHALL fail with an actionable message in a non-interactive shell. `oms status` SHALL continue to treat an omitted alias list as whole-workspace selection without prompting, and `oms record` SHALL resolve an omitted selection through the alias-resolution rules for its own command.

#### Scenario: Push selects every declared repo
- **WHEN** the user runs `oms push --all` with declared aliases `api` and `web`
- **THEN** the command pushes both `api` and `web` without prompting for a selection
- **AND** the command prints a final summary of per-alias results

#### Scenario: Push with an omitted alias list prompts interactively
- **WHEN** the user runs `oms push` with no alias and no `--all` in an interactive terminal
- **THEN** the command presents a multi-select list of declared repos
- **AND** the command pushes the chosen repos after the selection is confirmed

#### Scenario: Omitted selection fails non-interactively for every set command
- **WHEN** the user runs `oms sync`, `oms fetch`, `oms pull`, `oms push`, or `oms unsync` with no alias and no `--all` in a non-interactive shell
- **THEN** the command exits 1 before performing any repo operation
- **AND** the message identifies that a selection is required and names `--all` or an explicit alias
- **AND** the command does not open a prompt it cannot complete

#### Scenario: Explicit push alias list is unchanged
- **WHEN** the user runs `oms push api` or `oms push api web`
- **THEN** the command behaves exactly as before this change, including its output and exit code

#### Scenario: Record selects every moved pointer
- **WHEN** the user runs `oms record --all` and aliases `api`, `web`, and `core` all have moved root pointers
- **THEN** the command records all three pointers
- **AND** the command does not prompt for a selection

#### Scenario: Record with an omitted alias list prompts interactively
- **WHEN** the user runs `oms record` with no alias and no `--all` from outside any `oms/<alias>/` tree in an interactive terminal
- **THEN** the command presents a multi-select list of moved pointer candidates
- **AND** the command records the chosen aliases after the selection is confirmed

#### Scenario: Record with no moved pointers under whole-workspace selection is a no-op
- **WHEN** the user runs `oms record --all` and no declared alias has a moved root pointer
- **THEN** the command reports that there is nothing to record for any submodule
- **AND** exits 0
- **AND** the command does not create a root repository commit

#### Scenario: Explicit record alias is unchanged
- **WHEN** the user runs `oms record api`
- **THEN** the command behaves exactly as before this change, including its message, root commit message, and exit code

### Requirement: Multi-alias root pointer records
The system SHALL record several moved submodule gitlink updates in a single path-limited root repository commit. The commit message SHALL name the alias and its short SHA when exactly one alias is recorded, and SHALL omit alias names when several are recorded. Root-wide preconditions SHALL abort the whole invocation, while a per-alias precondition failure SHALL fail the command when the alias was named explicitly and SHALL skip that alias when it was selected by `--all`. A skipped alias whose only condition is an unmoved pointer SHALL NOT affect the exit code; any other skipped condition SHALL be reported and SHALL make the command exit 2. The unrelated-staged-paths check SHALL be evaluated against the selected alias set rather than the subset actually committed.

#### Scenario: Several aliases record as one commit
- **WHEN** aliases `api`, `web`, and `core` have moved root pointers and the user runs `oms record api web core`
- **THEN** the command stages only `oms/api`, `oms/web`, and `oms/core` in the root repository
- **AND** the command creates exactly one root repository commit with message `chore(oms): update submodules`
- **AND** the command prints the root commit short SHA and commit message
- **AND** exits 0

#### Scenario: Single alias keeps the named commit message
- **WHEN** only alias `api` is selected and its root pointer has moved
- **THEN** the root repository commit message is `chore(oms): update api submodule to <short-sha>`

#### Scenario: Named alias with a failed precondition fails the command
- **WHEN** the root repository has no recorded gitlink at `oms/api`
- **AND** the user runs `oms record api web`
- **THEN** the command fails and explains that `record` only updates existing root gitlinks
- **AND** if pending add topology is detected, the message points to `oms sync api --commit`
- **AND** the command does not create a root repository commit
- **AND** exits 1

#### Scenario: Whole-workspace selection skips an alias with a failed precondition
- **WHEN** the user runs `oms record --all`
- **AND** the root repository has no recorded gitlink at `oms/api`
- **AND** aliases `web` and `core` have moved root pointers
- **THEN** the command records `web` and `core` in one root repository commit
- **AND** the command reports `api` as failed together with its reason and recovery command
- **AND** the command prints a final summary of per-alias results
- **AND** exits 2

#### Scenario: Whole-workspace selection skips a pending removal
- **WHEN** the user runs `oms record --all`
- **AND** root HEAD has a gitlink at `oms/api` but the working tree path `oms/api` has been removed
- **THEN** the command reports `api` with its reason and points to `oms unsync api --commit`
- **AND** the command does not stage the `oms/api` removal
- **AND** the command records the remaining moved pointers
- **AND** exits 2

#### Scenario: Whole-workspace selection skips a staged pointer split
- **WHEN** the user runs `oms record --all`
- **AND** the staged pointer for `oms/api` differs from the working tree pointer for `oms/api`
- **AND** aliases `web` and `core` have moved root pointers
- **THEN** the command reports `api` and asks the user to unstage or restage `oms/api`
- **AND** the command records `web` and `core`
- **AND** the staged `oms/api` pointer is left in place
- **AND** exits 2

#### Scenario: An unmoved pointer is a benign skip
- **WHEN** the user runs `oms record --all` with declared aliases `api`, `web`, and `core`
- **AND** only `web` has a moved root pointer
- **THEN** the command records `web`
- **AND** the command does not report `api` or `core` as a problem
- **AND** exits 0

#### Scenario: Root-wide precondition aborts the whole invocation
- **WHEN** the user runs `oms record --all`
- **AND** the root repository is in detached HEAD, has a conflicted gitlink, or has an in-progress Git operation
- **THEN** the command fails without recording any alias
- **AND** the command does not create a root repository commit

#### Scenario: Unrelated staged paths are judged against the selected set
- **WHEN** the user runs `oms record --all` with declared aliases `api`, `web`, and `core`
- **AND** the root repository index has `oms/api` staged while `api` is skipped for a per-alias reason
- **AND** no path outside `oms/api`, `oms/web`, and `oms/core` is staged
- **THEN** the command does not report unrelated staged changes
- **AND** the command records the recordable aliases
- **AND** the staged `oms/api` pointer remains staged and uncommitted

#### Scenario: Staged paths outside the selected set still fail
- **WHEN** the user runs `oms record api web`
- **AND** the root repository index has a staged path outside `oms/api` and `oms/web`
- **THEN** the command fails with a message explaining that unrelated staged changes must be committed or unstaged first
- **AND** the command does not create a root repository commit

#### Scenario: Aggregated record hint after a multi-alias pointer move
- **WHEN** a single `oms pull --all` or `oms push --all` invocation moves the root pointer for more than one alias
- **THEN** the command prints one aggregated hint to run `oms record --all`
- **AND** the command does not stage or record any root pointer
