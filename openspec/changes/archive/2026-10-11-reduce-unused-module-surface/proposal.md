# Proposal

## Why

The audit found 35 exported declarations with no direct callers outside their declaring file, three unreachable prompt checks retained for type narrowing, and duplicated npm dist-tag parsing. These enlarge the Interface and spread Implementation knowledge without providing additional caller Leverage.

## What Changes

- Make the 35 confirmed file-local declarations private while retaining their Implementation and any types inferred through remaining exported functions. Preserve declarations used by tests, build scripts, and release tooling.
- Express the prompt queue's existing response-kind invariant in its internal types, removing the unreachable `useDefault` checks from multi-select, confirm, and text prompts without weakening fail-closed behavior.
- Move stable-version response parsing into the existing `package-channels` Module. Share dist-tag structure extraction internally while retaining separate, small Interfaces for stable updates and strict stable/beta compatibility decisions.
- Migrate all source and test callers of the relocated parser and remove its old export from `update.ts`; do not add forwarding aliases.
- Preserve CLI output, errors, exit codes, test-mode guards, network request behavior, package-manager mutation rules, and repository safety conditions.

## Capabilities

### New Capabilities

None. This change introduces no new externally observable behavior.

### Modified Capabilities

None. Existing self-update and guarded-prompt requirements remain unchanged. Set `skip_specs: true` in `.openspec.yaml`; do not create delta specs merely to describe internal restructuring.

## Impact

- Source: the 35 declarations identified across `alias-preparation`, `branch-baseline`, `env`, `git`, `gitmodules-reconcile`, `install-context`, `manifest`, `status`, `tree-ops`, `types`, `skills`, `prompts`, `prompt-adapter`, `submodule-config`, and `root-tx`; parser relocation in `update.ts` and `package-channels.ts`.
- Tests: existing prompt contracts in `tests/unit/prompt-adapter.test.ts` and parser contracts in `tests/unit/update-install-agent-skill.test.ts`, with focused regressions for select-default mismatches and stable-only parsing with malformed beta metadata. Update inventory records if contract ownership or registration changes.
- Records: a changeset explaining the behavior-preserving maintenance change; command documentation stays unchanged because command behavior does not change.
- Packaging: no new dependencies, package exports, commands, configuration, or adapters. The package distributes a bundled CLI, not the internal TypeScript Modules.
