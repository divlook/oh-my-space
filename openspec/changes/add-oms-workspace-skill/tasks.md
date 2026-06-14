## 0. Preconditions (before apply)

- [ ] 0.1 Before applying this change, the sibling change against the `ai-submodule-workflow` capability — expanding `oms status --help` to document the `schemaVersion` 1 `status --json` fields and fixing its `pointers` → `root.submodulePointers` label — must have landed. The skills defer field semantics to that help text, so shipping before it lands points agents at thin, partly wrong output. (Create that change first; this change does not edit `oms status --help` itself.)

## 1. Skill Source Files

- [ ] 1.1 Create `skills/oms-workspace/SKILL.md` (the broad-trigger skill) with frontmatter (`name`; `description` targeting general, scope-ambiguous workspace Git work plus `oms sync`/`oms unsync` topology in an `oms.yaml` workspace — not enumerating `commit`/`branch`, which the per-workflow skills own) and a body that is the scope guardrail: run `oms status --json` before Git work involving `oms/`, decide root versus `oms/<alias>` scope without guessing, never create a root pointer commit unless explicitly asked, and separate adding/removing a repo (`oms sync`/`oms unsync` stage the root topology — `.gitmodules` and the `oms/<alias>` gitlink — and commit it with `--commit`; run non-interactively without `--commit` it is left unstaged) from recording a moved pointer (`oms record`, which refuses adds/removals). Defer remaining flag detail to `oms sync --help` / `oms unsync --help`.
- [ ] 1.2 Create `skills/oms-pointer/SKILL.md` with the pointer-move-then-record sequence — after `oms commit` or `oms pull` moves a submodule's commit, run `oms record` — naming `oms commit -m "<message>"` (`-m` is required to create the commit), a warning against committing the root pointer by mistake, a `description` that names both `oms commit` and `oms pull` as triggers, and remaining flag detail deferred to `oms commit --help` / `oms pull --help` / `oms record --help`.
- [ ] 1.3 Create `skills/oms-branch/SKILL.md` with `oms switch` (new local branch) versus `oms checkout` (track remote) selection, detached HEAD avoidance, and flag detail deferred to `oms switch --help` / `oms checkout --help`.
- [ ] 1.4 In each of the three skills, carry the canonical scope-guardrail kernel verbatim (single-sourced from the `OMS_SCOPE_GUARDRAIL` constant), declare in the skill body (not the frontmatter) the `schemaVersion` it was written against with deferral to `oms status --help` on any *different* `schemaVersion`, and keep the body portable (no agent-specific slash-command syntax).
- [ ] 1.5 Extract the scope-guardrail kernel — run `oms status --json` before Git work involving `oms/`; each `oms/<alias>/` is a separate Git repository; do not guess root versus submodule scope; no root pointer commit for an existing pointer move without `oms record` — into an `OMS_SCOPE_GUARDRAIL` constant in `scripts/oms.ts`, and embed it in the `oms/` marker block (`OMS_INSTRUCTION_BLOCK`), keeping the marker's own `--help` line outside the kernel constant.

## 2. `oms skills` Command

- [ ] 2.1 Add `oms skills` to print both the project command `npx skills add divlook/oh-my-space` and the global variant `npx skills add divlook/oh-my-space -g`.
- [ ] 2.2 Add `oms skills --install [...args]` to resolve to the workspace root and delegate to `npx skills add divlook/oh-my-space [...args]` with inherited stdio, forwarding any extra arguments verbatim, returning the delegated exit code, and implementing no install logic itself.
- [ ] 2.3 Print the manual `npx skills add divlook/oh-my-space` command when delegation cannot execute; when run outside an `oms` workspace without `-g`, fail with a usage error pointing to the `-g` global install.
- [ ] 2.4 Add an internal `OMS_NPX_BIN` override so delegation can be tested without invoking real `npx`.
- [ ] 2.5 Add `oms skills` help text covering purpose, scope (project versus global), and at least one example.

## 3. Documentation

- [ ] 3.1 Add a README skill-installation section documenting `npx skills add divlook/oh-my-space`, the `-g` global install, `--skill <name>`, and `--list`, plus the purpose of each of the three skills (`oms-workspace`, `oms-pointer`, `oms-branch`).
- [ ] 3.2 Document the `oms skills` command in the README command reference.
- [ ] 3.3 Point the skills' field-semantics deferral at `oms status --help` (the version-matched authoritative source). Expanding that help text to document the `schemaVersion` 1 fields and fixing its `pointers` → `root.submodulePointers` label is out of scope here — it is a separate change against the `ai-submodule-workflow` capability that this change depends on.

## 4. Verification

- [ ] 4.1 Add CLI tests for `oms skills` output (both project and global commands), `--install` delegation through `OMS_NPX_BIN`, extra-argument passthrough, resolve-to-workspace-root behavior, the outside-workspace usage error, delegation-failure manual-command output, and help text.
- [ ] 4.2 Add checks that `skills/oms-workspace/`, `skills/oms-pointer/`, and `skills/oms-branch/` each contain a `SKILL.md` with valid `name`/`description` frontmatter, carry the `OMS_SCOPE_GUARDRAIL` kernel verbatim (literal substring, identical to the marker block), declare `schemaVersion` in the body (not the frontmatter), and contain no slash-command syntax. Also assert each body references `oms status --help` (the field-semantics deferral target), and that any body naming a normal-path flag cites the matching `--help` — a body mentioning `--commit` also contains `oms sync --help`/`oms unsync --help`, and the `oms-pointer` body naming `-m` contains `oms commit --help`. These are static substring checks over the known flag set, not a CLI flag-existence test.
- [ ] 4.3 Run the full test suite with `npm test`.
- [ ] 4.4 Manually verify `npx skills add divlook/oh-my-space --list` shows the three `oms` skills. Note: this round-trips through GitHub, so it only passes after the skills are pushed to the default branch; pre-merge verification is limited to 4.2 (files/frontmatter/kernel) and `OMS_NPX_BIN` delegation (4.1).
