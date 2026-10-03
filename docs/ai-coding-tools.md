# AI coding tools

An AI coding agent can accidentally commit in the main project instead of `oms/<alias>/`.
It can also record a source commit before it pushes that commit.
OMS provides machine-readable status, repository instructions, and installable skills to make that Git boundary explicit.

## Inspect workspace scope

Before an agent chooses where to branch or commit, run:

```bash
oms status --json
```

For the installed CLI's authoritative field contract, run `oms status --help`.

### Status reference

The command prints one schema-versioned JSON object with these fields:

- Workspace root
- Inferred current alias
- Recorded commits
- Source branches
- Dirtiness
- Ahead/behind state

The `trees` array lists managed trees under `.oms-tree/`, including broken links and foreign directories.

## Install repository instructions

Install an OMS-managed instruction block for supported coding agents:

```bash
oms agent install --target both
# or: --target agents | --target claude
```

Review these files.
Commit these files in the main project yourself.
Install workspace skills as well when an agent may start at the workspace root.

### Repository instruction reference

OMS writes `oms/AGENTS.md`, `oms/CLAUDE.md`, or both.
These files belong to the main project under `oms/`, not to a source repository.
The managed block uses `<!-- OMS START -->` and `<!-- OMS END -->` markers.
OMS preserves content outside those markers.
`oms agent uninstall` removes only the managed block.
It removes the file only if nothing remains.

OMS does not stage these files.
Sessions under `oms/` can see the marker block.

## Install workspace skills

Use project scope by default.
Project scope is the recommended choice because the skills apply only in an OMS workspace.

OMS publishes three skills through the external Vercel Labs `skills` tool:

```bash
npx skills add divlook/oh-my-space/skills
npx skills add divlook/oh-my-space/skills -g
npx skills add divlook/oh-my-space/skills --skill oms-pointer
npx skills add divlook/oh-my-space/skills --list
```

### Skill installation reference

`oms skills` prints the installation commands.
`oms skills --install` resolves the workspace root before it runs the project installation.
It forwards supported arguments to `npx skills`.

| Skill | Use it when | Guardrail |
| --- | --- | --- |
| `oms-workspace` | Git scope is ambiguous, a pointer moves, or you add or remove repositories. | Establishes main-project versus source-repository scope. Separates repository registration from recorded-commit updates. |
| `oms-pointer` | `oms commit` or `oms pull` moves a source checkout. | Pushes and records the moved commit deliberately. Excludes unrelated main-project paths. |
| `oms-branch` | You start or switch a branch in a source repository. | Chooses a new local branch versus an existing remote branch. Avoids an unintended detached checkout. |

Skill loading is best-effort.
An agent decides whether a skill description matches the task.
Skills complement the always-on marker block and built-in command help.
Skills do not replace either source of instructions.

## Keep installed skills current

Run:

```bash
oms doctor
```

### Skill metadata reference

Skills install from this repository, while the CLI installs from npm.
Skill freshness and OMS runtime compatibility can therefore change independently.
Each skill declares both contracts.
The following values illustrate metadata format, not live versions or compatibility requirements:

```yaml
compatibility: Requires oh-my-space >=1.0.0-0.
metadata:
  author: oh-my-space
  version: "1.1.0"
  oh-my-space-version: ">=1.0.0-0"
```

`metadata.version` is the skill content version:

- A major version changes the guardrail or scope contract.
- A minor version changes instructions or trigger descriptions.
- A patch changes wording only.

`metadata.oh-my-space-version` gives the machine-readable OMS range that the instructions require.
The top-level `compatibility` sentence must exactly mirror that range for humans and agents.

### Skill finding reference

`oms doctor` evaluates freshness and runtime compatibility independently.

**Freshness:**

- An older, missing, or unverifiable skill version prints the non-interactive `npx skills update <skill>` command.
- OMS reports a newer skill as content drift. This does not prove that OMS needs an update.

**Runtime compatibility:**

- OMS checks its running version against the installed skill's `metadata.oh-my-space-version`.
- Missing or malformed compatibility metadata points to a skill update or reinstall.
- A valid incompatible range triggers one best-effort npm channel lookup.
- OMS prefers a satisfying `latest` version. Otherwise, it recommends a satisfying `beta` version.

`oms update` performs the same checks when the CLI is already current.
After a CLI update, it directs you to `oms doctor`.
The old process cannot load the newly installed runtime's references.

All skill findings are informational.
They do not change the command's exit status.
An exact, compatible installation stays silent.
A registry lookup failure preserves the local mismatch report with explicit stable and beta inspection guidance.

## Recommended agent workflow

1. Run `oms status --json`.
2. Identify the main project and current source repository.
3. For a new local branch, use `oms branch switch`.
4. For an existing remote branch, use `oms branch checkout` instead.
5. Edit inside `oms/<alias>/`.
6. Run checks inside `oms/<alias>/`.
7. Use `oms commit <alias>` for the source repository.
8. Use `oms push <alias>` for the source repository.
9. Use `oms record <alias>` to commit the new recorded commit in the main project.
10. Run `oms status --json` again.
11. Check that no unintended Git scope changed.

For a second task in the same repository, use a managed tree instead of switching the canonical checkout:

1. Create the tree with `oms tree add <alias> <task>`.
2. Edit inside the tree.
3. Use plain Git inside the tree to commit changes.
4. Use plain Git inside the tree to manage branches.
5. Use plain Git inside the tree to push the `<task>` branch.
6. Open a pull request from the pushed branch.
7. After the pull request merges, run `oms pull <alias>`.
8. Then run `oms record <alias>`.
9. When the task ends, remove the tree with `oms tree remove <alias> <task>`.

### Managed tree reference

The tree occupies `.oms-tree/<alias>/<task>/` on the new `<task>` branch.
The canonical checkout does not move.
`oms` alias commands refuse to run inside a tree.
Run those commands from the canonical checkout or the workspace root.
The branch survives tree removal for later deletion or reuse.

The [Getting started](getting-started.md#complete-the-first-change) guide provides the human-readable workflow.
The [How OMS works](how-oms-works.md#two-git-boundaries) guide explains repository boundaries.
