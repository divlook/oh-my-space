## 1. Init guidance

- [ ] 1.1 In `runInit` (`scripts/oms.ts`), after the existing next-step hints, print an optional AI-setup hint section pointing to `oms agent install` and `oms skills`, reusing the `log.info` label plus indented `log.message` style already used by `runSkills`.
- [ ] 1.2 Print the same section after both fresh init and `--force` re-init, and do not gate it on `process.stdin.isTTY` (identical output in interactive and non-interactive shells; no prompt).
- [ ] 1.3 Confirm `runInit` still writes only `oms.yaml` — it creates no `oms/AGENTS.md` or `oms/CLAUDE.md` and runs no skills installer.

## 2. Tests

- [ ] 2.1 Add a CLI test that `oms init` output points to both `oms agent install` and `oms skills`, and that it creates no `oms/AGENTS.md` or `oms/CLAUDE.md`. Because the test harness runs with non-interactive stdin, this test also exercises the non-interactive-shell scenario, so no separate TTY test is needed.
- [ ] 2.2 Add a CLI test that `oms init --force` re-init prints the same AI-setup guidance.

## 3. Documentation and verification

- [ ] 3.1 Update the README `oms init` documentation to mention the optional AI-setup hints.
- [ ] 3.2 Run the full test suite with `npm test`.
- [ ] 3.3 Add a changeset summarizing the `oms init` AI-setup hints.
