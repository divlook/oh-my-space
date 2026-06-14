## Context

`oms init` scaffolds `oms.yaml`, ensures `oms/` is not gitignored, and prints next-step hints. The `improve-ai-submodule-workflow` change added `oms agent install [--target agents|claude|both]`, which writes a marker-managed OMS instruction block into `oms/AGENTS.md` and/or `oms/CLAUDE.md` (root-repository files). Today those two flows are disconnected: a user scaffolding a workspace is never told the agent-instructions command exists at the moment it is most useful.

The install logic already lives in `runAgentInstall` and its helpers (`agentTargetFiles`, `validateAgentFiles`, `installManagedBlock`, marker constants). This change wires `oms init` into that logic without duplicating it.

## Goals / Non-Goals

**Goals:**

- Offer agent-instruction installation at the end of a successful `oms init`, opt-in and never destructive.
- Reuse the existing `oms agent install` behavior (validation, block content, file handling, no staging) rather than re-implementing it.
- Keep `oms init` deterministic and non-blocking in non-interactive shells (CI, scripts).
- Keep `oms.yaml` creation the authoritative outcome of `oms init`; the agent step never changes that result.

**Non-Goals:**

- Changing `oms agent install`/`uninstall` behavior or the managed block content.
- Managing root-level `AGENTS.md`/`CLAUDE.md` (only `oms/` files, same as `oms agent`).
- Adding a non-interactive `oms init` flag to auto-install (a future option if needed; this change uses a hint instead).
- Installing the separate `oms` workspace skill (handled by the `add-oms-workspace-skill` change).

## Decisions

### Decision: Extract a shared install routine used by both `oms agent install` and `oms init`

Factor the core of `runAgentInstall` into a reusable function, e.g. `applyAgentInstall(repoRoot, target): number`, that performs the atomic malformed-marker pre-validation, creates `oms/` if needed, writes the managed block to each selected file, and does not stage. `runAgentInstall` keeps owning workspace resolution and `--target` resolution, then calls it; `runInit` calls it with `process.cwd()` and the target chosen by its own prompt.

Rationale: avoids duplicating validation and write logic, so the two entry points cannot drift. Alternative (duplicating the loop in `runInit`) was rejected because the marker/validation rules must stay identical.

### Decision: Interactive offer with an explicit Skip; hint-only when non-interactive

In an interactive terminal, after the existing init hints, prompt once: "Install AI agent instructions now?" with options `AGENTS.md` (→ `agents`), `CLAUDE.md` (→ `claude`), `AGENTS.md + CLAUDE.md` (→ `both`), and `Skip`. A Skip choice or a cancellation installs nothing and is a normal success. In a non-interactive shell, do not prompt; print a single hint line pointing to `oms agent install`.

This differs from `resolveAgentTarget` (which has no Skip and fails non-interactively), so `oms init` uses its own prompt rather than reusing `resolveAgentTarget`. Rationale: `oms init` must never block or fail because of the optional agent step, so Skip and a non-interactive hint are first-class.

### Decision: The agent step is best-effort and never fails init

`oms init` always reports `oms.yaml` creation and returns its existing success result. If `applyAgentInstall` reports a problem (for example pre-existing malformed markers in `oms/AGENTS.md` during a `--force` re-init), surface it as a warning and continue; do not abort or change the exit code. Rationale: the scaffold is the contract of `oms init`; the optional agent step is additive and must not regress init's reliability.

### Decision: `--force` re-init offers on the same terms

The offer/hint runs after both fresh init and `--force` re-init, since re-init is a legitimate moment to (re)install or refresh the managed block. The reused install routine already replaces exactly one existing block, so re-running is idempotent.

## Risks / Trade-offs

- [Prompting during `oms init` could surprise users who expect a one-shot scaffold] → Default is non-destructive, a Skip option is always present, and non-interactive runs never prompt.
- [Writing `oms/AGENTS.md`/`oms/CLAUDE.md` during init creates files some users will not want] → Files are written only on an explicit non-skip choice, are not staged, and are removable with `oms agent uninstall`.
- [Interactive prompt is hard to cover in the non-TTY test harness] → Test the non-interactive hint path and the extracted `applyAgentInstall` behavior; document the interactive prompt as a known non-TTY test gap, consistent with other interactive `oms` commands.

## Migration Plan

- Additive change; existing `oms init` invocations in scripts/CI are unaffected because non-interactive runs only print an extra hint line.
- No data migration. No change to `oms agent` commands.

## Open Questions

- None.
