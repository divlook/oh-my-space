## 1. Init guidance

- [ ] 1.1 In `runInit` (`scripts/oms.ts`), after the existing next-step hints, print an optional AI-setup hint section pointing to the bare commands `oms agent install` and `oms skills` (no `--target`/`--install`), reusing the `log.info` label plus indented `log.message` style already used by `runSkills`. Order `oms agent install` first, then `oms skills`. Each command line carries a short `# …` descriptor; the `oms skills` descriptor must say it shows how to install the workspace skills, not that it installs them (bare `oms skills` prints the installer command).
- [ ] 1.2 Print the same section after both fresh init and `--force` re-init, and do not gate it on `process.stdin.isTTY` (identical output in interactive and non-interactive shells; no prompt).
- [ ] 1.3 Confirm `runInit` still writes only `oms.yaml` — it creates no `oms/AGENTS.md` or `oms/CLAUDE.md` and runs no skills installer.

## 2. Tests

- [ ] 2.1 Add a CLI test that `oms init` output points to both `oms agent install` and `oms skills`, that init's output does *not* contain `npx skills add` (init signposts the command without expanding into the installer), and that it creates no `oms/AGENTS.md` or `oms/CLAUDE.md`. Because the test harness runs with non-interactive stdin (`run()` uses `spawnSync` with piped stdio), this test also exercises the non-interactive-shell scenario, so no separate TTY test is needed.
- [ ] 2.2 Add a CLI test that `oms init --force` re-init prints the same AI-setup guidance.

## 3. Documentation and verification

- [ ] 3.1 In the README Quick start section, add one sentence noting `oms init` prints optional AI-setup hints pointing to `oms agent install` and `oms skills`, linking to the existing "AI agent workflow" and "Workspace skills" sections rather than re-documenting the commands.
- [ ] 3.2 Run the full test suite with `npm test`.
- [ ] 3.3 Add a patch changeset summarizing the `oms init` AI-setup hints (additive output only — no new command, flag, or behavior change).
