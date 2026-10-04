# Design

## Context

See `proposal.md` for motivation. `scripts/oms.ts` registers commands through Commander. Its `exitWith` function waits for a numeric command result.

`selectRepos` in `scripts/lib/prompts.ts` checks explicit aliases. It removes duplicate aliases but retains their first-occurrence order. For `--all`, it uses manifest order. Existing unit tests assert this difference.

`runManage` changes repository state during shared preparation. The new runner must not use that function to execute commands. `runGit` uses synchronous processes and buffers their output. It supports Git, not arbitrary commands. Its execution model cannot provide responsive interruption and live output.

The existing `cli-automation-policy` requires automatic initialization. The policy delta exempts `exec`. Arbitrary commands may require local state that a newly initialized repository does not contain. Argument handling, output streams, and signals require decisions across the CLI and execution modules.

### Terms

- A canonical checkout is the declared source repository at `oms/<alias>/`.
- A target is one selected canonical checkout.
- A child is the process that executes the user command for one target.
- An invocation is one execution of `oms exec` across the selected targets.
- A spawn failure means that OMS cannot start a child.
- SIGINT is the interrupt signal that a terminal normally sends when the user presses Ctrl+C.
- Standard input, standard output, and standard error are stdin, stdout, and stderr.
- `argv` is the executable's argument list. `cwd` is its working directory.

## Goals / Non-Goals

**Goals:**

- Preserve each command argument exactly.
- Reuse selection and read-only workspace checks.
- Stream child output without retaining complete logs in memory.
- Distinguish target failure from interruption of the invocation.

**Non-Goals:**

- Do not add a shell parser, task scheduler, dependency graph, or parallel execution.
- Do not execute commands in managed trees.
- Do not add a sandbox, automatic retry, timeout, rollback, or manifest fields.
- User commands may access the network. OMS performs no additional network operations.

## Decisions

### Separate OMS arguments before Commander parses child arguments

For `exec`, separate the raw argument list at its first `--`.

1. Retain the executable and arguments after the separator without changing them.
2. Give Commander only the arguments before the separator.
3. Require a non-empty executable before selection or execution.
4. Register `exec` in `commandNames`.
5. Add dedicated command help.
6. Allow `oms exec --help` without a separator or executable.

OMS must not interpret child `--help`, child `--all`, or a second `--`. Keep this handling specific to `exec`. Do not change other commands' argument handling.

A single variadic alias argument would mix target selection with the command. That approach obscures the separator and child options. Joining arguments into a shell string loses their boundaries. It also introduces shell interpretation. Use neither approach.

### Reuse selection without changing target state

Add the entry point in `scripts/lib/exec.ts`.

1. Load the workspace through `loadForSubmodules`.
2. Apply the existing refusal for invocation from a managed tree.
3. Select repositories through `selectRepos(..., "exec")`.
4. Reject an empty workspace or cancelled selection before starting a child.

Do not infer the current alias. This command selects a set of repositories, like `fetch`. Preserve explicit alias order. Keep the shared selector's precedence for `--all`.

Immediately before each child starts, check that its target is eligible. Reuse read-only registration classification and `submoduleInitialized`. These checks must establish that the directory belongs to the declared canonical submodule. Earlier children may change later targets, so do not rely only on an initial check.

Do not execute commands in foreign directories that occupy a target path. Accept initialized targets with dirty files or detached HEAD. Report missing or inconsistent targets as failed. Include `oms sync <alias>` guidance.

Do not call these preparation operations:

- `prepareAlias` or `prepareAliases`.
- Detached-HEAD resolution.
- Transaction recovery that can finalize root state.

Automatic initialization could create a repository without the local state that the user command requires. It would also exceed the runner's documented scope. Reject that alternative.

### Use asynchronous direct spawn with inherited streams

Use Node's `spawn(executable, args, { cwd, shell: false, stdio: "inherit" })`. Inherit the caller's environment. Do not change the OMS process's working directory.

Wait for the child's `close` event before starting another target. Inherited streams avoid buffering complete build logs. They preserve stdin, stdout, stderr, terminal colors, and interactive child behavior.

Print an alias-labelled header before each child. Print a result row after each child. Sequential execution makes per-line output rewriting unnecessary. Include all selected aliases in the final summary, even for a single target.

Do not print the complete argument list by default. It may contain secrets.

### Preserve detailed results

Use an execution-specific result union. Retain distinct outcomes for:

- Success.
- Failure with a numeric child exit code.
- Failure with a child signal.
- Spawn failure.
- Target failure.
- Interruption.
- A target that did not execute because OMS interrupted the invocation.

Reuse existing formatting conventions. Do not reduce these results to `OperationResult`. That type cannot retain child exit codes and signal reasons.

A child can emit both `error` and `close`. Resolve the child's completion once. Add exactly one result for that target.

Use these OMS exit codes:

| Condition | OMS exit code |
| --- | --- |
| Every selected target succeeds | 0 |
| Usage, workspace discovery, or selection fails | 1 |
| A command or target fails | 2 |
| OMS interrupts the invocation | 130 |

Show numeric child exit codes in the results. Do not use them as the OMS exit code.

Do not reuse `runGit` or `spawnSync`. Commands are not necessarily Git commands. Synchronous buffering also prevents live output and a responsive signal handler.

### Maintain one interruption state

Keep one interruption flag and a reference to the active child. Install a temporary SIGINT handler before scheduling children.

When OMS receives SIGINT:

1. Set the interruption flag before signalling the active child.
2. Interrupt the active child, if one exists.
3. Do not start another child.
4. Wait for the active child to close.
5. Report completed results and interrupted targets.
6. Report remaining targets as not run.
7. Return 130.

If the active child closes with SIGINT, use the same interruption state. This applies even when the terminal signals the child before OMS. After OMS receives SIGINT, classify the active target as interrupted regardless of its eventual numeric exit code.

The terminal may signal both OMS and the child. Do not forward SIGINT repeatedly after interruption starts. Remove temporary handlers in `finally`. Preserve completed results and all child side effects.

Keep children in the foreground process group. This preserves interactive stdin. Terminal Ctrl+C can then reach ordinary tool descendants. If only OMS receives SIGINT, forward it to the immediate active child.

The runner does not contain descendants that intentionally detach. It does not forcibly kill a child that ignores SIGINT. Those guarantees need a separate termination policy for child processes and their descendants. Do not add an implicit timeout or forced termination.

### Use the existing test layers

Use unit tests for uncertain parser boundaries and exit-code decisions. Use integration tests with real temporary canonical repositories and real children.

Integration tests must cover these behaviors:

- Target eligibility.
- Literal arguments.
- Execution order.
- Continuation after failure.
- Preserved files and Git state.

Use black-box tests against the production bundle for these behaviors:

- The command's complete execution path.
- Child option handling.
- Live output.
- SIGINT prevents execution in later targets.

Synchronize signal tests on explicit child readiness. Do not use sleeps to infer readiness. Register tests in `tests/test-inventory.json`. Preserve the limit for each test owner.

During implementation, run these checks:

1. Run `npm run build`.
2. Run the relevant existing test-layer commands.
3. Run `npm test`.
4. Exercise the built CLI in a disposable workspace with two repositories.
5. Use a real Node command that produces distinct success and failure results.
6. Interrupt a ready child that runs until it receives a signal.
7. Check built-in help manually.

Do not run these implementation checks during planning. Do not add tests that assert help wording.

## Risks / Trade-offs

- User commands can change or remove data. Explain that `exec` is not a sandbox and does not undo child effects.
- Automatic preparation conflicts with `exec` scope. Apply the explicit policy delta without changing existing commands.
- Children consume stdin sequentially. Explain that OMS does not replay input for each repository.
- Child output does not provide a strict machine-readable format. Use readable headers and summaries. Exclude JSON output from this change.
- A child may ignore SIGINT or detach descendants. Document this limit. Guarantee that OMS starts no later targets after interruption.
- Platforms support different shell commands. Pass literal arguments with `shell: false`. Users must invoke an available shell explicitly.
- Some platform-specific wrappers require a shell. Do not silently execute those programs through a shell.

## Migration Plan

The new command requires no persistent data migration. Release the command, tests, documentation, and an English Changeset together.

A rollback removes the command and its documentation. It does not change workspace data or existing command contracts. This planning change does not implement the command.
