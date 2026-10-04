# workspace-command-execution Specification

## Purpose

Execute user commands across selected canonical checkouts without implicit preparation. Define literal argument handling, sequential execution, results, and interruption. A canonical checkout is the declared source repository at `oms/<alias>/`.

## Requirements

### Requirement: Explicit command boundary
OMS SHALL accept `oms exec [aliases...] [--all] -- <command> [args...]`. The first `--` SHALL separate OMS arguments from the child command. OMS SHALL pass the executable and arguments after that separator unchanged. OMS SHALL NOT interpret shell syntax or parse child arguments as OMS options.

#### Scenario: Child options and literal arguments
- **WHEN** the user supplies a command after `--`
- **AND** its arguments contain spaces, an empty string, `*`, a semicolon, `$HOME`, `--all`, or another `--`
- **THEN** the child receives the exact argument values that OMS received after the executable
- **AND** OMS does not expand the values or interpret them as shell commands

#### Scenario: Explicit shell syntax
- **WHEN** the user runs `oms exec api -- sh -c 'npm test && npm run build'`
- **THEN** OMS executes `sh` with separate arguments for `-c` and the script
- **AND** only the explicitly invoked shell interprets the script

#### Scenario: Missing command boundary or executable
- **WHEN** the invocation omits the separator or supplies no non-empty executable after it
- **THEN** OMS exits 1 with usage guidance
- **AND** OMS does not prompt or start a child

### Requirement: Repository selection
OMS SHALL reuse workspace discovery and selection for sets of repositories. Explicit aliases SHALL execute once in first-occurrence order. `--all` SHALL select every declared alias in manifest order. Omitted selection SHALL prompt only in an interactive terminal. OMS SHALL check the complete selection before starting a child. `--all` SHALL take precedence over explicit aliases.

#### Scenario: Explicit order and deduplication
- **WHEN** the user runs `oms exec web api web -- npm test`
- **THEN** OMS executes once in `web` and then once in `api`

#### Scenario: Whole workspace
- **WHEN** the user runs `oms exec --all -- npm test`
- **THEN** OMS selects all declared aliases in manifest order
- **AND** OMS includes unavailable targets when reporting failures

#### Scenario: Omitted interactive selection
- **WHEN** the user omits aliases and `--all` in an interactive terminal
- **THEN** OMS offers the existing repository multi-select before execution

#### Scenario: Omitted non-interactive selection
- **WHEN** the user omits aliases and `--all` in a non-interactive session
- **THEN** OMS exits 1 with explicit-alias and `--all` guidance
- **AND** OMS starts no child

#### Scenario: Unknown explicit alias
- **WHEN** a selection without `--all` includes an unknown alias
- **THEN** OMS exits 1 before executing commands for any alias

#### Scenario: Invalid workspace
- **WHEN** workspace discovery finds an invalid nearest manifest
- **OR** the manifest directory is not the required root Git top-level
- **THEN** OMS exits 1 without executing commands
- **AND** OMS does not use an outer workspace instead

### Requirement: Canonical targets without preparation
OMS SHALL execute only in initialized canonical checkouts with consistent registration. Children SHALL inherit the caller's environment and standard input. Dirty and detached checkouts SHALL remain eligible. Missing, uninitialized, occupied, or inconsistently registered targets SHALL fail individually. OMS SHALL NOT initialize, register, fetch, switch branches, or repair targets as preparation.

#### Scenario: Local-only checkout
- **WHEN** the selected canonical repository has an initialized checkout
- **AND** the checkout is dirty or detached
- **AND** no remote is reachable
- **THEN** OMS runs the user command in that checkout
- **AND** OMS does not contact a remote or change the branch as preparation

#### Scenario: Unavailable target
- **WHEN** a selected target is unavailable or has inconsistent registration
- **THEN** OMS reports the alias, failure reason, and preserved target state
- **AND** OMS provides `oms sync <alias>` guidance
- **AND** OMS does not execute a child there or change the target
- **AND** OMS continues with later eligible targets

#### Scenario: Invocation from a managed tree
- **WHEN** the user invokes `oms exec` inside `.oms-tree/`
- **THEN** OMS refuses before starting a child
- **AND** OMS directs the user to execute the command from the workspace root
- **AND** OMS does not substitute a canonical checkout for the current task tree

### Requirement: Sequential execution and output
OMS SHALL execute at most one selected command at a time. OMS SHALL wait for each child to finish before considering the next alias. OMS SHALL stream child stdout and stderr without rewriting or accumulating complete output. OMS SHALL identify each alias in its output header and the final summary.

#### Scenario: Sequential attributable output
- **WHEN** two selected repositories execute commands that write to stdout and stderr
- **THEN** each child's output follows its alias-labelled header
- **AND** the second child starts only after the first child finishes
- **AND** OMS displays output while each child runs

### Requirement: Independent failures and aggregate results
OMS SHALL continue after child non-zero exits, non-interrupt signals, spawn failures, and unavailable targets. The summary SHALL report each selected alias's outcome. OMS SHALL report numeric child exit codes or signal, spawn, and target failure reasons. OMS SHALL exit 0 only when all targets succeed. Execution or target failures SHALL return 2. Usage or workspace selection errors SHALL return 1.

#### Scenario: Mixed results
- **WHEN** the first selected child exits 7 and the next exits 0
- **THEN** both commands execute once
- **AND** the summary associates each alias with its child exit code
- **AND** OMS exits 2 rather than forwarding exit 7

#### Scenario: Spawn failure
- **WHEN** OMS cannot start the executable for a selected target
- **THEN** OMS reports a spawn failure for that alias
- **AND** OMS does not invent a child exit code
- **AND** OMS continues with later aliases
- **AND** OMS exits 2

### Requirement: Whole-invocation interruption
OMS SHALL treat Ctrl+C or SIGINT as interruption of the invocation. OMS SHALL stop scheduling aliases and interrupt the active child. OMS SHALL exit 130 after that child finishes. A child that ends with SIGINT SHALL also interrupt the invocation. The summary SHALL distinguish completed results, interrupted targets, and targets that did not execute because of interruption.

#### Scenario: Interrupt active command
- **WHEN** the user interrupts OMS while a selected command runs
- **THEN** OMS interrupts that command
- **AND** OMS starts no later selected commands
- **AND** OMS exits 130 after the active child finishes
- **AND** OMS preserves completed effects
- **AND** OMS reports unstarted aliases as not run

#### Scenario: Child receives terminal interrupt
- **WHEN** the terminal sends SIGINT to the active child and the child exits
- **THEN** OMS does not continue as if an ordinary target failure occurred
- **AND** OMS exits 130 without starting another child

### Requirement: User-controlled side effects
OMS SHALL perform no implicit commit, push, pointer recording, or rollback around command execution. Help SHALL explain that children retain the user's permissions. Children can change files, Git state, or remote services. Help SHALL state that this runner is not a sandbox.

#### Scenario: Supplied command modifies a file
- **WHEN** a child changes a file and then fails
- **THEN** OMS preserves the child's changes
- **AND** OMS reports the failure without committing or undoing those changes
