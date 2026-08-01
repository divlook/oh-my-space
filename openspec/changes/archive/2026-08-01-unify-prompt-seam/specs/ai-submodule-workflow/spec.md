## MODIFIED Requirements

### Requirement: Guarded deterministic prompt responses
The system SHALL expose deterministic prompt responses only when `OMS_TEST_MODE=1` and `OMS_TEST_PROMPT_RESPONSES` are both set, without changing normal interactive behavior. Every command that gates a prompt on whether a decision can be answered SHALL use one shared predicate that treats an active response queue as equivalent to a terminal, and SHALL open only guarded prompts behind that predicate.

#### Scenario: Typed test responses drive prompts
- **WHEN** `OMS_TEST_MODE=1` and `OMS_TEST_PROMPT_RESPONSES` contains a JSON array
- **THEN** each entry is one of `{"type":"select","value":"..."}`, `{"type":"confirm","value":true|false}`, `{"type":"multiselect","values":["...", "..."]}`, `{"type":"text","value":"..."}`, or `{"type":"cancel"}`
- **AND** the queue supplies responses in prompt order even when stdin is not a TTY
- **AND** no real prompt is opened

#### Scenario: Multi-select responses supply an ordered value list
- **WHEN** a `multiselect` entry is consumed for a multi-select prompt
- **THEN** the command receives the entry's `values` array as the selected set
- **AND** an entry whose `values` is not an array of strings fails closed

#### Scenario: Text responses supply a free-form value
- **WHEN** a `text` entry is consumed for a free-form text prompt
- **THEN** the command receives the entry's `value` string
- **AND** an entry whose `value` is not a string fails closed
- **AND** an empty string is a valid entry, so a command's own rejection of empty input remains observable

#### Scenario: One predicate decides prompt availability
- **WHEN** any command must decide whether an interactive decision can be answered
- **THEN** the decision uses the single shared predicate rather than a locally defined copy
- **AND** an active response queue satisfies that predicate exactly as a terminal does
- **AND** every prompt opened behind that predicate is a guarded prompt

#### Scenario: Invalid test response configuration fails closed
- **WHEN** the queue JSON is malformed, an entry has an unknown shape, its type does not match the next prompt, or responses remain at command completion
- **THEN** the command exits 1 without falling back to a real prompt

#### Scenario: Prompt injection is disabled normally
- **WHEN** either `OMS_TEST_MODE=1` or `OMS_TEST_PROMPT_RESPONSES` is absent
- **THEN** the command ignores injected responses
- **AND** uses normal TTY detection and prompt behavior

#### Scenario: Non-gating terminal checks are unaffected
- **WHEN** a command uses a terminal check to select a safe default rather than to gate a decision
- **THEN** that check is not required to treat an active response queue as a terminal
- **AND** the command's chosen default is unchanged

## ADDED Requirements

### Requirement: Bounded fetch recovery for submodule set commands
`oms fetch` SHALL retry a failed fetch exactly once per remote before reporting failure for that alias, matching the bounded retry `oms branch list` already performs.

#### Scenario: Transient fetch failure recovers silently
- **WHEN** `oms fetch api` runs `git fetch <remote> --prune` and the first attempt fails
- **AND** an immediate second attempt with the same arguments succeeds
- **THEN** the command treats the fetch as successful
- **AND** does not report the recovered first failure as an error
- **AND** continues to the alias's remaining remotes

#### Scenario: Exhausted fetch failure is reported
- **WHEN** both fetch attempts for a remote fail
- **THEN** the command reports the failure for that alias with the Git exit code
- **AND** the alias contributes a failed result to the run's exit code
- **AND** later aliases in the same invocation are still processed

#### Scenario: Fetch retry does not extend to pull or push
- **WHEN** `oms pull` or `oms push` fails
- **THEN** the command reports the failure without retrying
