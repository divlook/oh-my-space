## Context

`oms init` scaffolds `oms.yaml`, ensures `oms/` is not gitignored, and prints next-step hints (run `git init` if needed, then "edit alias/remotes/branch, then run `oms sync`"). Two optional commands set up AI guidance for the workspace:

- `oms agent install [--target agents|claude|both]` — writes the marker-managed OMS instruction block into `oms/AGENTS.md` and/or `oms/CLAUDE.md` (owned by the `ai-submodule-workflow` capability).
- `oms skills [--install]` — prints, or with `--install` runs, the command that installs the OMS workspace skills (owned by the `ai-workspace-skill` capability).

Today `oms init` mentions neither, so a user finishes scaffolding with no signpost to either. This change adds a signpost and nothing more.

## Goals / Non-Goals

**Goals:**

- Make both AI-setup commands discoverable at the moment they are most relevant — right after `oms init`.
- Stay consistent with `oms init`'s existing behavior (one-shot scaffold plus printed hints) and with `oms skills`'s print-don't-run idiom.
- Keep `oms init` deterministic and side-effect-free beyond `oms.yaml`: identical output in interactive and non-interactive shells.
- Be fully testable, with no interactive path.

**Non-Goals:**

- Installing agent instructions or skills from `oms init` (no file writes, no `npx`). Those stay opt-in via their own commands.
- An interactive prompt at init (explicitly rejected — see Decisions).
- Changing `oms agent install`/`uninstall` or `oms skills` behavior or content.
- Auto-installing AI instructions or skills by default.

## Decisions

### Decision: Hints, not a prompt

`oms init` prints an optional AI-setup hint section instead of prompting to install. The stated problem is discoverability, which a hint solves at the right altitude; a prompt solves activation (conversion), a different goal, and would add an untestable interactive path plus a best-effort failure contract (what should happen if the install fails after `oms.yaml` already succeeded?). The hint matches `oms init`'s existing next-step hints and `oms skills`'s own print-don't-run design.

Rationale: keeps the change small, fully testable, and aligned with existing idioms. Alternative (an interactive offer that installs the block) was rejected: higher install conversion is not the stated goal, the prompt is a surprising departure from init's one-shot scaffold character, and it would single out `oms agent install` while leaving `oms skills` undiscovered.

### Decision: Point to both `oms agent install` and `oms skills`

The hint section references both AI-setup commands, not just agent instructions. Both are equally invisible after init and both serve the same purpose — making AI agents work well with the workspace — so a user who wants one likely wants the other. Pointing to only one would be arbitrary.

Reuse the existing output style: `runSkills` already prints a `log.info` label followed by indented `log.message` command lines. The init hint section follows the same shape for visual consistency.

### Decision: Init writes only `oms.yaml`

The hint section is pure output; `oms init` creates no instruction or skill files. This keeps `oms.yaml` the single authoritative outcome of init and removes any need for best-effort failure handling — there is nothing the AI-setup step can fail at, because it does nothing but print.

### Decision: Same hints on `--force` re-init

Re-init prints the same hint section. Re-init is also a legitimate moment to discover the commands, and since nothing is installed there is no idempotency concern.

### Decision: Identical output interactive and non-interactive

The hint section does not depend on `process.stdin.isTTY`. A printed hint is safe and useful in both modes; gating it would add complexity for no benefit and make CI output differ from local runs.

## Risks / Trade-offs

- [Lower install conversion than an interactive prompt] → Accepted: discoverability is the goal, and users who want to install run one clear command. If conversion later proves to be the real need, an explicit prompt or a dedicated `oms onboard` flow can be added on top without undoing this change.
- [Extra output lines on every init] → The section is short and clearly optional, consistent with the existing next-step hints; users who do not want it simply ignore it.

## Migration Plan

- Additive and output-only. Existing `oms init` invocations in scripts/CI are unaffected except for extra hint lines on stdout.
- No data migration. No behavior change to `oms agent` or `oms skills`.

## Open Questions

- Exact wording and format of the hint section are left to implementation; tests assert that both commands are mentioned, not the exact text, to avoid brittle assertions.
