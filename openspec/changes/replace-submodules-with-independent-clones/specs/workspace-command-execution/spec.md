# Spec Delta

## MODIFIED Requirements

### Requirement: Canonical targets without preparation
OMS SHALL execute only in verified independent canonical checkouts. Children SHALL inherit the caller's environment and standard input. Dirty and detached checkouts SHALL remain eligible. Missing, uninitialized, occupied, legacy, or otherwise invalid targets SHALL fail individually. OMS SHALL NOT clone, migrate, fetch, switch branches, or repair targets as preparation.

#### Scenario: Local-only checkout
- **WHEN** the selected canonical repository has an initialized checkout
- **AND** the checkout is dirty or detached
- **AND** no remote is reachable
- **THEN** OMS runs the user command in that checkout
- **AND** OMS does not contact a remote or change the branch as preparation

#### Scenario: Unavailable target
- **WHEN** a selected target is unavailable or is not a verified independent checkout
- **THEN** OMS reports the alias, failure reason, and preserved target state
- **AND** OMS provides `oms clone <alias>` guidance for missing checkouts and migration or repair guidance for other unavailable targets
- **AND** OMS does not execute a child there or change the target
- **AND** OMS continues with later eligible targets

#### Scenario: Invocation from a managed tree
- **WHEN** the user invokes `oms exec` inside `.oms-tree/`
- **THEN** OMS refuses before starting a child
- **AND** OMS directs the user to execute the command from the workspace root
- **AND** OMS does not substitute a canonical checkout for the current task tree

### Requirement: User-controlled side effects
OMS SHALL perform no implicit commit, push, or rollback around command execution. Help SHALL explain that children retain the user's permissions. Children can change files, Git state, or remote services. Help SHALL state that this runner is not a sandbox.

#### Scenario: Supplied command modifies a file
- **WHEN** a child changes a file and then fails
- **THEN** OMS preserves the child's changes
- **AND** OMS reports the failure without committing or undoing those changes
