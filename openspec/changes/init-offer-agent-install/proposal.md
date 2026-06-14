## Why

`oms agent install` exists but is easy to miss: a new workspace is scaffolded with `oms init`, and users rarely discover the agent-instruction command until later. Offering it at init time is the natural moment to set up AI agent guidance, while keeping it opt-in.

## What Changes

- After `oms init` writes `oms.yaml` (including `--force` re-init), in an interactive terminal it offers to install OMS agent instructions, with choices for `oms/AGENTS.md`, `oms/CLAUDE.md`, both, or skip.
- On a non-skip choice, `oms init` installs the managed OMS instruction block into the selected file(s) by reusing the existing `oms agent install` behavior (marker-managed block, malformed-marker validation, create `oms/` if needed, no Git staging).
- In a non-interactive shell, `oms init` does not prompt; it prints a one-line hint to run `oms agent install` instead.
- The agent-instruction step is best-effort: `oms init` still reports `oms.yaml` creation success, and an agent-install failure (for example malformed existing markers) is surfaced as a warning without changing the init success result.

## Capabilities

### New Capabilities
- `init-agent-onboarding`: Covers how `oms init` offers and installs AI agent instruction files at scaffold time, including interactive selection, the non-interactive hint, and best-effort failure handling.

### Modified Capabilities
- None. (The `oms agent install`/managed-block behavior it reuses is owned by the separate `ai-submodule-workflow` capability and is not changed here.)

## Impact

- `runInit` in `scripts/oms.ts` (reuses the existing agent-install helpers).
- README `oms init` documentation.
- CLI tests in `tests/cli.test.js`.
- New OpenSpec capability `init-agent-onboarding`.
- Depends on the `oms agent install` command and managed-block helpers introduced by the `improve-ai-submodule-workflow` change.
