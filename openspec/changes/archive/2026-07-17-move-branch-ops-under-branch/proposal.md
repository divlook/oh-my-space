## Why

Branch management is split across three top-level command surfaces: `oms switch`, `oms checkout`, and the `oms branch` group (which currently owns only `list` and `delete`). This scatters one lifecycle — inspect, start/switch, track, delete — across the CLI root. Consolidating switch and checkout under `oms branch` makes the group the single, coherent namespace for the whole branch lifecycle.

## What Changes

- Add `oms branch switch [alias] [branch]` and `oms branch checkout [alias] [branch]` as subcommands of the `oms branch` group, reusing the existing `runSwitch`/`runCheckout` implementations unchanged.
- **BREAKING**: Remove the top-level `oms switch` and `oms checkout` commands with no deprecated aliases. `oms switch <args>` and `oms checkout <args>` will fail as unknown commands.
- Extend the interactive `oms branch` action selector to offer four actions in lifecycle order: `list`, `switch`, `checkout`, `delete`.
- Update every user-facing guidance string that suggests `oms switch <alias> <branch>` (detached-HEAD hints in pull/push/commit/doctor/delete, and the checkout-not-found hint) to the new `oms branch switch <alias> <branch>` form.
- Update the `oms-branch` workspace skill and README to document the relocated commands.
- Add a migration doc (`docs/migrations/0.13.x-to-0.14.0.md`) with a 1:1 command mapping table.

## Capabilities

### New Capabilities
<!-- None. This relocates existing behavior; it introduces no new capability. -->

### Modified Capabilities
- `ai-submodule-workflow`: The "Interactive branch action selection" requirement changes — the `oms branch` group now hosts `switch` and `checkout` subcommands (replacing the top-level commands), and the action selector exposes all four lifecycle actions. Cross-reference guidance strings that name `oms switch` are updated to `oms branch switch`.
- `ai-workspace-skill`: The skill guidance requirement changes — it instructs `oms branch switch` / `oms branch checkout` and defers flag detail to their `--help`, instead of the top-level command names.

## Impact

- **Code**: `scripts/oms.ts` (command registration + `commandNames` set), `scripts/lib/branch-delete.ts` (`runBranch` action selector). Guidance strings in `scripts/lib/manage-ops.ts`, `scripts/lib/doctor.ts`, `scripts/lib/commit.ts`, `scripts/lib/branch-delete.ts`, `scripts/lib/branch-ops.ts`. The `runSwitch`/`runCheckout` implementations themselves are unchanged.
- **Docs**: `README.md`, `skills/oms-branch/SKILL.md`, new `docs/migrations/0.13.x-to-0.14.0.md`.
- **Users**: Breaking CLI change. Anyone or any script calling `oms switch` / `oms checkout` must move to `oms branch switch` / `oms branch checkout`. Pre-1.0 (current 0.13.0), so a minor bump (0.14.0) covers the break; no deprecation window per project convention (prior breaks used migration docs, not aliases).
- **Tests**: Existing switch/checkout/branch tests under `tests/` that invoke the old command paths must be updated to the new subcommand paths.
