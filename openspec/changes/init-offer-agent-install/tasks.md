## 1. Reusable install routine

- [ ] 1.1 Extract a shared `applyAgentInstall(repoRoot, target)` routine from `runAgentInstall` that runs atomic malformed-marker pre-validation, creates `oms/` if needed, writes the managed block to each selected file without staging, and returns a success/failure result.
- [ ] 1.2 Update `runAgentInstall` to call the extracted routine after resolving the workspace root and `--target`, preserving its current behavior.

## 2. Init offer

- [ ] 2.1 After a successful `oms init` (fresh and `--force` re-init), in an interactive terminal prompt "Install AI agent instructions now?" with choices `oms/AGENTS.md` (agents), `oms/CLAUDE.md` (claude), `oms/AGENTS.md + oms/CLAUDE.md` (both), and Skip.
- [ ] 2.2 On a non-skip choice, install the managed block for the selected target via `applyAgentInstall` using the init working directory; on Skip or cancellation, install nothing.
- [ ] 2.3 In a non-interactive shell, do not prompt; print a one-line hint to run `oms agent install` and create no instruction files.
- [ ] 2.4 Keep the agent step best-effort: always report `oms.yaml` creation success, and surface an `applyAgentInstall` failure (for example malformed existing markers) as a warning without aborting init or changing its exit result.

## 3. Tests

- [ ] 3.1 Add a CLI test that non-interactive `oms init` prints the `oms agent install` hint and creates no `oms/AGENTS.md` or `oms/CLAUDE.md`.
- [ ] 3.2 Add a CLI test that the extracted install routine path (via `oms agent install`) still creates one managed block per file and does not stage, guarding against regressions from the refactor.
- [ ] 3.3 Note in the tasks/spec that the interactive init offer (target selection and Skip) is not exercisable by the non-TTY test harness, matching the existing interactive-command test limitation.

## 4. Documentation and verification

- [ ] 4.1 Update the README `oms init` documentation to describe the interactive agent-instruction offer and the non-interactive hint.
- [ ] 4.2 Run the full test suite with `npm test`.
- [ ] 4.3 Add a changeset summarizing the `oms init` agent-instruction offer.
