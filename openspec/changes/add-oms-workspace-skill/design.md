## Context

The `ai-submodule-workflow` change gives `oms` machine-readable state (`oms status --json`) and scoped commands (`oms commit`, `oms record`) plus an `oms agent install` marker block under `oms/`. Two gaps remain for AI-assisted work:

- The marker block lives under `oms/` and is only reliably read when the agent works inside `oms/`; sessions that start at the workspace root may never see it.
- Agents need procedural guidance for cross-command flows (commit then record, branch start) that no single `--help` page covers.

`skills` (Vercel Labs `npx skills`) installs `SKILL.md` files from a GitHub repo into agent skill directories, discovered by the agent regardless of working directory but loaded only when the agent judges the skill's `description` relevant — best-effort, not a hook.

## Goals / Non-Goals

**Goals:**

- Deliver the scope guardrail to root-level sessions the marker block cannot reach.
- Provide cross-command workflow guidance (commit then record, branch selection) that complements `--help` rather than restating it.
- Keep each skill self-sufficient and low-coupling so best-effort firing and schema evolution do not break it.
- Guide users to install the skills through `oms skills`.

**Non-Goals:**

- A hard guarantee that `oms status --json` runs before Git work. Skills are best-effort; a guarantee would require a hook, which is explicitly not added.
- Per-command skills, which would duplicate `oms <command> --help`.
- sync/unsync workflow skills, deferred until a concrete failure the umbrella and `--help` cannot prevent justifies them.
- Implementing or vendoring the `skills` tool itself.

## Decisions

### Decision: Three skills sliced by use-case, not by command

Publish `oms-workspace` (umbrella) plus `oms-commit-record` and `oms-branch` (workflow satellites). The slicing seam is the cross-command workflow, not the CLI command.

Alternatives considered: a single monolithic skill (loses precise workflow triggers and crowds unrelated guidance); one skill per command (each would restate `oms <command> --help`, moving duplication rather than removing it, and multiplies triggers that must each fire). Use-case slicing keeps satellites additive to `--help` and keeps the trigger surface small.

### Decision: The umbrella is the guardrail, not a router

Because skill firing is best-effort, the umbrella cannot guarantee it loads before the agent acts, so it cannot reliably route. Its real and only distinct job is delivering the scope guardrail (run `oms status --json`, decide root versus submodule scope without guessing, do not commit the root pointer unprompted) to root-level sessions the marker cannot reach. Routing to a satellite, when it happens, is incidental.

### Decision: Layered division of labor with a deliberately duplicated guardrail

- `oms status --json`: ground-truth state.
- `oms <command> --help`: authoritative per-command syntax (volatile).
- Marker block (`oms/AGENTS.md`): the always-on guardrail, reliable when the agent works inside `oms/`.
- Umbrella skill: the same guardrail, delivered to root-level sessions; satellites: cross-command procedures.

The one-line scope guardrail is intentionally duplicated across the marker, the umbrella, and each satellite: every delivery mechanism has a blind spot (the marker is not read at the root; a skill may not fire), so duplicating the slow-changing principle keeps the guardrail present whichever layer reaches the agent. Procedures live only in the relevant satellite; syntax lives only in `--help`.

### Decision: Procedure-centric JSON coupling with a schema fail-safe

Skills encode the stable decision procedure, not the `oms status --json` field list. They declare an expected `schemaVersion: 1`, point to the README `status --json` section for exact field semantics, and instruct checking documentation when a higher `schemaVersion` appears. This keeps volatile detail in one authoritative place so additive schema evolution does not require editing the skills.

### Decision: Distribution and version coupling

Skills are published as `skills/<name>/SKILL.md` at the repository root and installed with `npx skills add divlook/oh-my-space` (`--skill <name>` for one, `--list` to list). The skill sources live in the same repository as the CLI and ship in the same release, so the `schemaVersion` the skills depend on and the CLI that emits it stay in lockstep. Skill bodies stay portable, avoiding agent-specific slash-command syntax, because the tool does not provide per-agent variants.

### Decision: `oms skills` is a thin pointer to the external tool

`oms skills` prints `npx skills add divlook/oh-my-space`; `oms skills --install` delegates to it with inherited stdio and returns its exit code, printing the manual command on failure. It implements no install logic. An internal `OMS_NPX_BIN` override lets tests exercise delegation without invoking real `npx`. This command and its scenarios were moved out of `ai-submodule-workflow`, with the corrected `npx skills add` syntax (the `add` subcommand is required).

## Risks / Trade-offs

- Best-effort firing means no guarantee the guardrail reaches the agent before Git work → mitigated by the always-on marker for inside-`oms/` sessions and self-sufficient satellites that restate the guardrail; the residual gap is an accepted, documented limitation.
- The guardrail is duplicated across marker and skills → mitigated by duplicating only the slow-changing one-liner; all syntax stays in `--help`.
- The `skills` tool is external and may evolve → mitigated by keeping `oms skills` a thin pointer and testing delegation through `OMS_NPX_BIN`.
- Skills can drift from the `oms status --json` schema → mitigated by co-located same-release publishing, a `schemaVersion: 1` declaration, and deferral to the README schema section.

## Migration Plan

- This change depends on `ai-submodule-workflow` landing `oms status --json`, `oms commit`, and `oms record`; implement the skills and `oms skills` after those primitives exist.
- The `oms skills` command, spec, and tasks were already removed from `ai-submodule-workflow` and are re-introduced here with `npx skills add` syntax.

## Open Questions

- Skill names (`oms-workspace`, `oms-commit-record`, `oms-branch`) are proposed, not yet ratified; confirm at implementation.
- Whether `oms-sync`/`oms-unsync` workflow skills are later promoted depends on a concrete failure the umbrella and `--help` cannot prevent.
