# AI coding tools

An AI coding agent can accidentally commit in the main project when it meant to commit in `oms/<alias>/`, or record a source commit before it is pushed. OMS provides machine-readable status, repository instructions, and installable skills to make that Git boundary explicit.

## Inspect workspace scope

Run this before an agent chooses where to branch or commit:

```bash
oms status --json
```

The command prints one schema-versioned JSON object describing the workspace root, inferred current alias, recorded commits, source branches, dirtiness, and ahead/behind state. Run `oms status --help` for the authoritative field contract of the installed CLI.

## Install repository instructions

Install an OMS-managed instruction block for supported coding agents:

```bash
oms agent install --target both
# or: --target agents | --target claude
```

OMS writes `oms/AGENTS.md`, `oms/CLAUDE.md`, or both. These are main-project files under `oms/`, not files inside a source repository. The managed block is delimited by `<!-- OMS START -->` and `<!-- OMS END -->`.

Content outside those markers is preserved. `oms agent uninstall` removes only the managed block and deletes the file only if nothing remains. OMS does not stage these files; review and commit them in the main project yourself.

This marker is visible to sessions working under `oms/`. Install workspace skills as well when an agent may start at the workspace root.

## Install workspace skills

OMS publishes three skills through the external Vercel Labs `skills` tool:

```bash
npx skills add divlook/oh-my-space/skills
npx skills add divlook/oh-my-space/skills -g
npx skills add divlook/oh-my-space/skills --skill oms-pointer
npx skills add divlook/oh-my-space/skills --list
```

Project scope is the default and recommended choice because the skills apply only in an OMS workspace. `oms skills` prints the installation commands. `oms skills --install` runs the project installation after resolving the workspace root and forwards supported arguments to `npx skills`.

| Skill | Use it when | Guardrail |
| --- | --- | --- |
| `oms-workspace` | Git scope is ambiguous, a pointer moved, or repositories are being added or removed. | Establishes main-project versus source-repository scope and separates repository registration from recorded-commit updates. |
| `oms-pointer` | `oms commit` or `oms pull` moved a source checkout. | Pushes and records the moved commit deliberately without including unrelated main-project paths. |
| `oms-branch` | Starting or switching a branch in a source repository. | Chooses a new local branch versus an existing remote branch and avoids an unintended detached checkout. |

Skill loading is best-effort: an agent decides whether a skill description matches the task. Skills complement the always-on marker block and built-in command help; they do not replace either.

## Keep installed skills current

Skills install from this repository while the CLI installs from npm, so skill freshness and OMS runtime compatibility can drift independently. Each skill declares both contracts:

```yaml
compatibility: Requires oh-my-space >=1.0.0-0.
metadata:
  author: oh-my-space
  version: "1.1.0"
  oh-my-space-version: ">=1.0.0-0"
```

`metadata.version` is the skill content version. A major version changes the guardrail or scope contract, a minor version changes instructions or trigger descriptions, and a patch changes wording only. `metadata.oh-my-space-version` is the machine-readable OMS range required by those instructions. The top-level `compatibility` sentence must exactly mirror that range for humans and agents.

Run:

```bash
oms doctor
```

`oms doctor` evaluates two dimensions independently:

- **Freshness:** An older, missing, or unverifiable skill version prints the non-interactive `npx skills update <skill>` command. A newer skill is reported as content drift, but does not prove that OMS must be updated.
- **Runtime compatibility:** The running OMS version is checked against the installed skill's `metadata.oh-my-space-version`. Missing or malformed compatibility metadata points back to a skill update or reinstall. A valid incompatible range triggers one best-effort npm channel lookup: a satisfying `latest` is preferred, otherwise a satisfying `beta` is recommended.

`oms update` performs the same checks when the CLI is already current. After a CLI update, it points back to `oms doctor` because the old process cannot load the newly installed runtime's references.

All skill findings are informational and do not change the command's exit status. An exact, compatible installation stays silent, and a registry lookup failure preserves the local mismatch report with explicit stable and beta inspection guidance.

## Recommended agent workflow

1. Run `oms status --json` and identify the main project and current source repository.
2. Use `oms branch switch` for a new local branch or `oms branch checkout` for an existing remote branch.
3. Edit and run checks inside `oms/<alias>/`.
4. Use `oms commit <alias>` and `oms push <alias>` for the source repository.
5. Use `oms record <alias>` to commit the new recorded commit in the main project.
6. Run `oms status --json` again and confirm that no unintended Git scope changed.

See [Getting started](getting-started.md#complete-the-first-change) for the human-readable workflow and [How OMS works](how-oms-works.md#two-git-boundaries) for repository boundaries.
