## Context

The `ai-submodule-workflow` capability (now landed) gives `oms` machine-readable state (`oms status --json`) and scoped commands (`oms commit`, `oms record`) plus an `oms agent install` marker block under `oms/`. Two gaps remain for AI-assisted work:

- The marker block lives under `oms/` and is only reliably read when the agent works inside `oms/`; sessions that start at the workspace root may never see it.
- Agents need procedural guidance for cross-command flows (commit then record, branch start) that no single `--help` page covers.

`skills` (Vercel Labs `npx skills`) installs `SKILL.md` files from a GitHub repo into agent skill directories. Project-scoped skills installed at the workspace root are discovered from the root and its subdirectories (agents such as Claude Code walk up to the repository root); they are loaded only when the agent judges the skill's `description` relevant — best-effort, not a hook.

## Goals / Non-Goals

**Goals:**

- Deliver the scope guardrail to root-level sessions the marker block cannot reach, on a best-effort basis.
- Provide cross-command workflow guidance (commit then record, branch selection) that complements `--help` rather than restating it.
- Keep each skill self-sufficient and low-coupling so best-effort firing and schema evolution do not break it.
- Guide users to install the skills through `oms skills`.

**Non-Goals:**

- A hard guarantee that `oms status --json` runs before Git work. Skills are best-effort; a guarantee would require a hook, which is explicitly not added.
- An always-on guardrail at the workspace root. `oms` deliberately does not manage root-level `AGENTS.md`/`CLAUDE.md` files (an `ai-submodule-workflow` non-goal), so the root is covered only by the best-effort skill, with no always-on fallback. This is an accepted limitation (see Risks).
- Per-command skills, which would duplicate `oms <command> --help`.
- A dedicated sync/unsync workflow skill. The repo add/remove topology-versus-pointer distinction is carried in the broad-trigger skill body instead; a separate skill is deferred until repo add/remove proves frequent or risky enough to earn its own trigger.
- Implementing or vendoring the `skills` tool itself.

## Decisions

### Decision: Three skills sliced by use-case, named by Git domain

Publish `oms-workspace` (the broad-trigger skill) plus `oms-pointer` and `oms-branch` (per-workflow skills). The slicing seam is the cross-command workflow, not the CLI command.

The three skills are named by the Git domain each manages — workspace scope, the root pointer, branches — not by the action they perform; the action verbs (`status`, `record`, `switch`/`checkout`) live in each skill's `description` and body. This keeps the set consistent: `oms-workspace` no more names "status" in its title than `oms-branch` names "switch".

Alternatives considered: a single monolithic skill (loses precise workflow triggers and crowds unrelated guidance); one skill per command (each would restate `oms <command> --help`, moving duplication rather than removing it, and multiplies triggers that must each fire). Use-case slicing keeps the per-workflow skills additive to `--help` and keeps the trigger surface small.

### Decision: Cover topology and pull inside existing skills, not new ones

Two cross-command flows fall outside the three skills' obvious triggers: recording the pointer after `oms pull` (not only `oms commit`) fast-forwards a submodule, and committing the root topology after `oms sync`/`oms unsync` adds or removes a repo. Rather than add skills for them, the existing skills absorb both — `oms-pointer` covers any command that moves a submodule's commit (`oms commit` or `oms pull`) and names both in its `description` so it fires on either; the broad-trigger skill carries the topology-versus-pointer distinction: adding or removing a repo stages the root topology (`.gitmodules` and the `oms/<alias>` gitlink), which `oms sync`/`oms unsync` commit with `--commit` (or, interactively, a default-Yes prompt) — run non-interactively without `--commit`, the topology is left unstaged for the user to commit — while `oms record` records a moved pointer only and refuses adds and removals.

This keeps the trigger surface small (the slicing-seam value above) and fits the broad-trigger skill's job of owning scope decisions — topology versus pointer is one. The `oms sync` → `oms record` confusion is concrete, not hypothetical: a non-interactive agent that skips the `oms sync` commit prompt may reach for `oms record`, which refuses adds. So it is handled now in the skill bodies rather than deferred, while a dedicated `oms-sync`/`oms-unsync` skill stays a non-goal until repo add/remove earns its own trigger.

### Decision: The broad-trigger skill owns the status-first scope decision, not routing

Because skill firing is best-effort, the broad-trigger skill cannot guarantee it loads before the agent acts, so it cannot reliably route to another skill. Its distinct job is not merely delivering the guardrail to root-level sessions — the per-workflow skills reach those sessions too. It is the only skill whose trigger is broad enough to fire for general, scope-ambiguous Git work that the narrow per-workflow triggers miss: committing "everything" from the root (root gitlink versus submodule source?), reading an `oms status` pointer that has moved, or debugging a push. Its `description` therefore targets that general, scope-ambiguous workspace Git work and `oms sync`/`oms unsync` topology, rather than enumerating `commit`/`branch` (which would collide with the per-workflow triggers); overlap with the per-workflow skills is acceptable because the agent loads every relevant skill rather than routing to one. That gap is exactly where scope confusion does damage, the marker is not read at the root, and no per-workflow skill fires — so the broad-trigger skill is what carries the guardrail there, as the root's only (best-effort) layer. It therefore owns the status-first scope-decision procedure (run `oms status --json`, read the pointer state, choose root versus `oms/<alias>` without guessing, and never commit the root pointer unprompted), with the guardrail kernel as its foundation. Routing to a per-workflow skill, when it happens, is incidental.

### Decision: Layered division of labor with a single-sourced guardrail kernel

- `oms status --json`: ground-truth state.
- `oms <command> --help`: authoritative per-command syntax (volatile).
- Marker block (`oms/AGENTS.md`): the always-on guardrail, reliable when the agent works inside `oms/`.
- Broad-trigger skill (`oms-workspace`): the status-first scope-decision procedure for general workspace Git work, reaching root-level sessions on a best-effort basis; per-workflow skills (`oms-pointer`, `oms-branch`): one cross-command procedure each.

The coverage is layered everywhere except the workspace root, and that exception is deliberate. Inside `oms/`, two layers reach the agent: the always-on marker and the best-effort skill. At the workspace root there is no always-on layer — the marker is not read there and `oms` does not manage root-level files (Non-Goals) — so the root is covered by the best-effort skill alone. The principle "the guardrail is present whichever layer reaches the agent" holds inside `oms/`, not at the root; the root is an accepted single-layer gap (see Risks).

The scope-guardrail kernel — run `oms status --json` before Git work involving `oms/`; each `oms/<alias>/` is a separate Git repository; do not guess root versus submodule scope; do not create a root pointer commit for an existing pointer move unless the user runs `oms record` — is the slow-changing principle every layer must state. It is defined once as a constant (`OMS_SCOPE_GUARDRAIL`) in `scripts/oms.ts`; the marker block embeds it (with its own `--help` line kept outside the constant), and each published `SKILL.md` carries it verbatim. Because a `SKILL.md` is a static file the `skills` tool installs verbatim (symlinking by default, or copying with `--copy`), the copies cannot be generated from the constant at install time, so a test asserts the constant is a literal substring of the marker output and of each `SKILL.md`, failing the build if any copy drifts. The kernel carries only the reminder to run `oms status --json`; the full status-first scope-decision procedure (read the pointer state, choose root versus `oms/<alias>` scope) still lives in exactly one skill — the broad-trigger skill — as each cross-command flow lives in its per-workflow skill; the surrounding procedural prose differs per skill and is not required to match; all syntax beyond the normal-path flags a skill names lives only in `--help`.

### Decision: Procedure-centric JSON coupling with a schema fail-safe

Skills encode the stable decision procedure, not the `oms status --json` field list. Each skill body — not its frontmatter, which neither the `skills` tool nor the agent reliably surfaces for custom fields — declares the `schemaVersion` it was written against (`1`), points to `oms status --help` for exact field semantics, and instructs the agent to defer to `oms status --help` when `oms status --json` reports a *different* schemaVersion. Because `oms status --help` ships with the installed CLI, it always matches the schemaVersion the CLI emits, eliminating the GitHub-skill-versus-npm-CLI skew for field semantics (see Distribution and version coupling). This keeps volatile detail in one authoritative place so additive schema evolution does not require editing the skills.

### Decision: Distribution and version coupling

Skills are published as `skills/<name>/SKILL.md` at the repository root and installed with `npx skills add divlook/oh-my-space` (`--skill <name>` for one, `--list` to list). The default install is project-scoped: run at the workspace root, the skills land in the workspace's agent skill directory and are discovered from the root and its subdirectories — within the workspace, not across workspaces. `oms skills` also surfaces the `-g` global variant for users who prefer one cross-workspace install; project scope is the default because these skills are only relevant in an `oms.yaml` workspace, and a project install keeps them out of unrelated repositories' skill rosters.

Co-located same-release publishing keeps the `schemaVersion` and the CLI in lockstep *in the repository*, but not necessarily on a user's machine: skills are pulled by `npx skills` from GitHub while the CLI is an independently versioned npm install, so the two can diverge. For field semantics that divergence is harmless because skills defer to `oms status --help`, which ships with the installed CLI and so always matches the observed schemaVersion; expanding that help text to document the `schemaVersion` 1 fields is a separate change against the `ai-submodule-workflow` capability that this change depends on. The normal-path flags a skill names (`-m`, `--commit`) are the one piece of CLI surface a skill states directly, so they can drift from the CLI (see Risks); the `--help` citation beside each named flag is what recovers the agent. Skill bodies stay portable, avoiding agent-specific slash-command syntax, because the tool does not provide per-agent variants.

### Decision: `oms skills` is a thin pointer to the external tool

`oms skills` prints both the project-scope command `npx skills add divlook/oh-my-space` and the global variant `npx skills add divlook/oh-my-space -g`. `oms skills --install [...args]` resolves to the workspace root, then delegates to `npx skills add divlook/oh-my-space [...args]` with inherited stdio, passing any extra arguments straight through (so `-g`, `--skill`, `--copy`, and `--list` work without `oms` knowing about them) and returning the delegated exit code. Resolving to the workspace root is the only `oms`-specific behavior: it prevents a project install from landing in a submodule's directory when the command is run from inside `oms/<alias>/`. Run outside an `oms` workspace without `-g`, the command fails with a usage error and points to the `-g` global install. On delegation failure it prints the manual command. It implements no install logic. An internal `OMS_NPX_BIN` override lets tests exercise delegation without invoking real `npx`. This command and its scenarios were moved out of `ai-submodule-workflow`, with the corrected `npx skills add` syntax (the `add` subcommand is required).

## Risks / Trade-offs

- Best-effort firing means no guarantee the guardrail reaches the agent before Git work. Inside `oms/`, the always-on marker is the fallback; at the workspace root there is no always-on fallback (the marker is not read there and `oms` does not manage root-level files), so the root is covered by the best-effort skill alone. This single-layer root coverage is an accepted, documented limitation; promoting it to a guarantee would require a root marker or a hook, both out of scope here.
- The guardrail kernel is duplicated across the marker and skills → mitigated by single-sourcing the kernel as a constant and asserting it verbatim in the marker and every `SKILL.md` with a drift test; only the slow-changing kernel is shared, and all syntax beyond the normal-path flags a skill names stays in `--help`.
- The `skills` tool is external and may evolve → mitigated by keeping `oms skills` a thin pass-through and testing delegation through `OMS_NPX_BIN`.
- Skills can drift from the `oms status --json` schema, and a user's installed skill and CLI can be different versions (GitHub vs npm channels) → mitigated by the body-level `schemaVersion` declaration and deferral to `oms status --help`, which ships with the installed CLI and so always matches the observed schemaVersion; co-located same-release publishing aligns the repository but is not relied on for the user's machine.
- Skills name the normal-path flags required to complete their workflow (`oms commit -m`, `oms sync`/`oms unsync --commit`), so those flag names can drift if the CLI renames them → mitigated by keeping the named set to normal-path completion flags only (selection flags and `--force` stay in `--help`) and citing the command's `--help` beside each named flag so the agent self-corrects; the residual drift is accepted rather than guarded by a test, because parsing flags out of skill prose is brittle.

## Migration Plan

- This change depended on `ai-submodule-workflow` landing `oms status --json`, `oms commit`, and `oms record`; those have shipped, so the skills and `oms skills` can be implemented now.
- The `oms skills` command, spec, and tasks were already removed from the `ai-submodule-workflow` capability's planning and are re-introduced here with `npx skills add` syntax.

## Open Questions

- Skill names are settled: `oms-workspace`, `oms-pointer`, `oms-branch`, named by the Git domain each manages.
- Whether `oms-sync`/`oms-unsync` workflow skills are later promoted depends on a concrete failure the broad-trigger skill and `--help` cannot prevent.
