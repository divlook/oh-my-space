## Why

`oms init` scaffolds `oms.yaml` but never points the user to the two optional commands that set up AI guidance for the workspace: `oms agent install` (writes the managed OMS instruction block into `oms/AGENTS.md` / `oms/CLAUDE.md`) and `oms skills` (the entry point for installing the OMS workspace skills). Both are most relevant immediately after init, yet a user finishes scaffolding with no signpost to either, so they are easy to miss.

The fix that fits OMS's existing idiom is a hint, not a prompt: `oms init` already prints next-step hints, and `oms skills` (without `--install`) already prints its install command rather than running it. Discoverability is the problem, so a short optional next-steps section is the proportionate solution — and it can point to both commands instead of singling one out.

## What Changes

- After `oms init` writes `oms.yaml` (fresh init and `--force` re-init), it prints an optional "AI setup" hint section pointing to `oms agent install` and `oms skills`.
- The hints are output-only and deterministic: identical in interactive and non-interactive shells, with no prompt and no new interactive surface.
- `oms init` continues to write only `oms.yaml`. It never creates `oms/AGENTS.md`, `oms/CLAUDE.md`, or installs skills; those remain the job of their own commands.
- README `oms init` documentation mentions the AI-setup hints.

## Capabilities

### New Capabilities
- `init-onboarding`: Covers how `oms init` guides a new user after scaffolding, specifically the optional hints that surface the AI-setup commands (`oms agent install`, `oms skills`).

### Modified Capabilities
- None. `oms agent install` is owned by `ai-submodule-workflow` and `oms skills` by `ai-workspace-skill`; this change only references them and changes neither.

## Impact

- `runInit` in `scripts/oms.ts` (adds hint output only; no logic extracted or refactored).
- README `oms init` documentation.
- CLI tests in `tests/cli.test.js`.
- New OpenSpec capability `init-onboarding`.
- No dependency on extracting `oms agent install` internals; no behavior change to `oms agent` or `oms skills`.
