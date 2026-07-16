## 1. Relocate the commands in the CLI

- [x] 1.1 In `scripts/oms.ts`, register `switch` and `checkout` as subcommands of `branchCommand`, wired to the existing `runSwitch` / `runCheckout` from `branch-ops.js` (preserve arguments, the `--from` option, help text, and `exitWith` wrapping).
- [x] 1.2 In `scripts/oms.ts`, remove the top-level `program.command("switch")` and `program.command("checkout")` registrations.
- [x] 1.3 In `scripts/oms.ts`, remove `"switch"` and `"checkout"` from the `commandNames` set so `oms switch`/`oms checkout` fall through to the unknown-command guard.
- [x] 1.4 In `scripts/oms.ts`, update the `branchCommand` `.description` (currently "Inspect or delete submodule branches (interactive action selector).") so it also names switch and checkout (e.g. "Inspect, switch, checkout, or delete submodule branches").

## 2. Extend the interactive branch selector

- [x] 2.1 In `scripts/lib/branch-delete.ts` `runBranch`, add `switch` and `checkout` to the `guardedSelect` options in lifecycle order: `list`, `switch`, `checkout`, `delete`.
- [x] 2.2 Dispatch the new choices to `runSwitch(undefined, undefined, {})` and `runCheckout(undefined, undefined)` (import from `branch-ops.js`) so each subcommand's own interactive alias/branch pickers run.

## 3. Update user-facing hint strings

- [x] 3.1 Update detached-HEAD hints from `oms switch <alias> <branch>` to `oms branch switch <alias> <branch>` in `scripts/lib/manage-ops.ts` (pull and push paths), `scripts/lib/doctor.ts`, `scripts/lib/commit.ts`, and `scripts/lib/branch-delete.ts`.
- [x] 3.2 Update the checkout-not-found hint (line 97) and both stale code comments (line 47 `"oms checkout"`, line 59 `"oms switch"`) in `scripts/lib/branch-ops.ts` to reference `oms branch switch` / `oms branch checkout`.
- [x] 3.3 Grep the `scripts/` tree for any remaining `oms switch` / `oms checkout` strings and confirm none point users at a removed top-level command.

## 4. Update tests

- [x] 4.1 In `tests/cli.test.js`, change every oms CLI invocation `run(["switch", ...])` / `run(["checkout", ...])` to `run(["branch", "switch", ...])` / `run(["branch", "checkout", ...])` (leave raw `git(..., "checkout", ...)` calls untouched).
- [x] 4.2 Update output assertions that match `oms switch ...` (e.g. `/oms switch api feature\/new/`, `/oms switch api/`) to the new `oms branch switch ...` form.
- [x] 4.3 Add a test asserting `oms switch` and `oms checkout` now exit non-zero as unknown commands.
- [x] 4.4 Add tests for the interactive `oms branch` selector offering `switch` and `checkout` and dispatching into their flows.
- [x] 4.5 Run `npm test` and confirm the full suite passes.

## 5. Update documentation

- [x] 5.1 Update `README.md`: command table rows, the "Start branches locally" section, the interactive-omit note, the `oms-branch` skill row, any `oms switch` / `oms checkout` examples to `oms branch switch` / `oms branch checkout`, and the interactive `oms branch` selector descriptions (line ~95 "choose list or delete interactively" and line ~116 "interactive list/delete action selector") so they name all four lifecycle actions (list, switch, checkout, delete).
- [x] 5.2 Update `skills/oms-branch/SKILL.md` (description and body) to reference `oms branch switch` / `oms branch checkout` and defer flag detail to their `--help`.
- [x] 5.3 Create `docs/migrations/0.13.x-to-0.14.0.md` with a 1:1 mapping table (`oms switch …` → `oms branch switch …`, `oms checkout …` → `oms branch checkout …`) and note that top-level commands are removed with no aliases.
- [x] 5.4 Add the new migration doc to the README migrations list.

## 6. Release metadata

- [x] 6.1 Add a changeset (minor bump, 0.13.0 → 0.14.0) summarizing the breaking relocation of `oms switch` / `oms checkout` under `oms branch`.

## 7. Verify

- [x] 7.1 Run `npm run build` and manually confirm: `oms branch` selector shows four actions; `oms branch switch`/`oms branch checkout` work; `oms switch`/`oms checkout` fail as unknown commands.
- [x] 7.2 Run `openspec validate move-branch-ops-under-branch` and confirm it passes.
- [x] 7.3 Confirm no doc or help string still describes the `oms branch` selector as list/delete-only: check `README.md`, `skills/oms-branch/SKILL.md`, and `oms branch --help` describe all four lifecycle actions (this catches descriptions that omit the `oms switch`/`oms checkout` strings the section-3 grep relies on).
