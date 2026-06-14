## 1. Skill Source Files

- [ ] 1.1 Create `skills/oms-workspace/SKILL.md` (umbrella) with frontmatter (`name`, `description` targeting Git/commit/branch/push/sync work in an `oms.yaml` workspace) and a body that is the scope guardrail: run `oms status --json` before Git work involving `oms/`, decide root versus `oms/<alias>` scope without guessing, and never create a root pointer commit unless explicitly asked.
- [ ] 1.2 Create `skills/oms-commit-record/SKILL.md` with the commit-then-record sequence (`oms commit` then `oms record`), a warning against committing the root pointer by mistake, and flag detail deferred to `oms commit --help` / `oms record --help`.
- [ ] 1.3 Create `skills/oms-branch/SKILL.md` with `oms switch` (new local branch) versus `oms checkout` (track remote) selection, detached HEAD avoidance, and flag detail deferred to `oms switch --help` / `oms checkout --help`.
- [ ] 1.4 In each of the three skills, restate the one-line scope guardrail so the skill is self-sufficient, declare an expected `schemaVersion: 1` with deferral to the README `status --json` section, and keep the body portable (no agent-specific slash-command syntax).

## 2. `oms skills` Command

- [ ] 2.1 Add `oms skills` to print `npx skills add divlook/oh-my-space` as the install command.
- [ ] 2.2 Add `oms skills --install` to delegate to `npx skills add divlook/oh-my-space` with inherited stdio, return the delegated exit code, and implement no install logic itself.
- [ ] 2.3 Print the manual `npx skills add divlook/oh-my-space` command when delegation cannot execute.
- [ ] 2.4 Add an internal `OMS_NPX_BIN` override so delegation can be tested without invoking real `npx`.
- [ ] 2.5 Add `oms skills` help text covering purpose, scope, and at least one example.

## 3. Documentation

- [ ] 3.1 Add a README skill-installation section documenting `npx skills add divlook/oh-my-space`, `--skill <name>`, and `--list`, plus the purpose of each of the three skills.
- [ ] 3.2 Document the `oms skills` command in the README command reference.
- [ ] 3.3 Confirm the README `status --json` section is the authoritative schema source the skills point to, and cross-link it.

## 4. Verification

- [ ] 4.1 Add CLI tests for `oms skills` guidance output, `--install` delegation through `OMS_NPX_BIN`, delegation-failure manual-command output, and help text.
- [ ] 4.2 Add checks that `skills/oms-workspace/`, `skills/oms-commit-record/`, and `skills/oms-branch/` each contain a `SKILL.md` with valid `name`/`description` frontmatter, restate the scope guardrail, declare `schemaVersion: 1`, and contain no slash-command syntax.
- [ ] 4.3 Run the full test suite with `npm test`.
- [ ] 4.4 Manually verify `npx skills add divlook/oh-my-space --list` shows the three `oms` skills.
