## Why

`oms` exposes AI-facing primitives (`oms status --json`, `oms commit`, `oms record` from the now-landed `ai-submodule-workflow` capability), but agents still need procedural guidance to use them with the correct repository scope. The `oms agent install` marker block lives under `oms/` and is not read by sessions started at the workspace root, so an installable skill — discovered for sessions started at the workspace root and its subdirectories — carries the guardrail to the root, which the marker cannot reach. At the root the skill is the only guardrail layer and its firing is best-effort (model-judged), so reaching the root is improved, not guaranteed.

## What Changes

- Publish three skills under `skills/<name>/SKILL.md` at the repository root, installable with `npx skills add divlook/oh-my-space` (the `add` subcommand is required; `--skill <name>` installs one, `--list` lists them). The three skills are named by the Git domain each manages — `oms-workspace`, `oms-pointer`, `oms-branch` — with the action verbs carried in each skill's `description` and body, not its name:
  - `oms-workspace` (the broad-trigger skill): owns the status-first scope decision, not routing. Its `description` targets general, scope-ambiguous workspace Git work — committing "everything" from the root, reading a moved `oms status` pointer, debugging a push — plus `oms sync`/`oms unsync` topology, which no other skill covers; it does not enumerate `commit`/`branch`, which the per-workflow skills own. The body instructs running `oms status --json` before Git work involving `oms/`, deciding root versus `oms/<alias>` scope without guessing, and never creating a root pointer commit unless explicitly asked. It also separates repo add/remove topology — `oms sync`/`oms unsync` stage the root topology and commit it with `--commit` (run non-interactively without `--commit`, the topology is left unstaged) — from pointer recording (`oms record`, which records a moved pointer only and refuses adds/removals).
  - `oms-pointer` (a per-workflow skill): the cross-command pointer-move-then-record loop — after `oms commit` or `oms pull` moves a submodule's commit, record the root pointer with `oms record` — so submodule source commits are not left without a recorded root pointer and the root pointer is not committed by mistake. Its `description` names both `oms commit` and `oms pull` as triggers so it fires on either.
  - `oms-branch` (a per-workflow skill): choosing `oms switch` (new local branch) versus `oms checkout` (track an existing remote branch) and avoiding detached HEAD.
- A canonical scope-guardrail kernel — run `oms status --json` before Git work involving `oms/`; each `oms/<alias>/` is a separate Git repository; do not guess root versus submodule scope; do not create a root pointer commit for an existing pointer move unless the user runs `oms record` — is carried verbatim in every skill and in the `oms/` marker block. It is defined once as a constant in `scripts/oms.ts`, and a test asserts each `SKILL.md` and the marker contain it, so the copies cannot drift. Skill firing is best-effort, so a skill must not assume the broad-trigger skill loaded first.
- Skills defer exact `oms status --json` field semantics to `oms status --help` as the authoritative source. Each skill body (not its frontmatter) declares the `schemaVersion: 1` it was written against and instructs the agent to defer to `oms status --help` when `oms status --json` reports a *different* schemaVersion. A skill names only the flags required to complete its normal workflow path — `oms commit -m`, `oms sync`/`oms unsync --commit` — and defers all other flag and syntax detail (selection flags, `--force`, and the like) to `oms <command> --help`, which each flag-naming skill also cites. Skill bodies stay portable, with no agent-specific slash-command syntax.
- Add the `oms skills` command (moved here from `ai-submodule-workflow`): it prints the project-scope install command `npx skills add divlook/oh-my-space` and the global variant `npx skills add divlook/oh-my-space -g`. `oms skills --install [...args]` resolves to the workspace root and delegates to `npx skills add divlook/oh-my-space [...args]` with inherited stdio (passing extra arguments straight through, so `-g`, `--skill`, and `--copy` work without `oms`-specific handling) and returns its exit code; run outside an `oms` workspace without `-g`, it fails with a usage error pointing to the `-g` global install; on delegation failure it prints the manual command. An internal `OMS_NPX_BIN` override allows testing without real `npx`.
- Document the skills and the `oms skills` command in the README.

## Capabilities

### New Capabilities
- `ai-workspace-skill`: Covers the installable `oms` workspace skills (a broad-trigger scope-decision skill plus per-workflow skills) and the `oms skills` command that guides users to install them.

### Modified Capabilities
- None. The `oms skills` requirement was removed from the `ai-submodule-workflow` capability's planning before it produced a main spec, so there is no archived spec to modify.

## Impact

- New `skills/oms-workspace/`, `skills/oms-pointer/`, `skills/oms-branch/` skill sources.
- New `oms skills` command in `scripts/oms.ts` with CLI tests in `tests/cli.test.js`.
- A reusable scope-guardrail kernel constant in `scripts/oms.ts`, shared by the `oms/` marker block and asserted verbatim against each `SKILL.md`.
- README skill installation and command-reference updates.
- Depends on the `ai-submodule-workflow` capability (landed via the `improve-ai-submodule-workflow` change) having shipped `oms status --json`, `oms commit`, and `oms record`; the skills are meaningless without those primitives.
- Depends on `oms status --help` documenting the `schemaVersion` 1 `status --json` fields, which the skills defer to for field semantics; expanding that help text (and fixing its `pointers` → `root.submodulePointers` label) is a separate change against the `ai-submodule-workflow` capability, not this one.
- The `oms skills` command and its scenarios were already removed from the `ai-submodule-workflow` capability's planning and belong to this change.
