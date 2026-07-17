## Why

OMS discovers `oms.yaml` above the current directory, but the supported execution contexts, nearest-manifest behavior, and relationship between the manifest directory and the root Git repository are not defined in one contract. In particular, a manifest created below an existing Git top-level can pass the current repository check while OMS and Git operate against different roots, making submodule topology unsafe.

## What Changes

- Define workspace discovery as selecting the nearest `oms.yaml` regular file from the current directory upward, without falling back past an invalid nearest candidate.
- Preserve workspace-root execution and current configured-submodule execution, including explicit-alias precedence and current-alias inference where already supported.
- Validate that commands which manage submodule topology use a manifest directory that is the root Git top-level, with canonical path comparison and actionable diagnostics on mismatch.
- Prevent `oms init` from scaffolding a nested manifest below an existing Git top-level while continuing to allow initialization in a directory that is not yet a Git repository.
- Align tests, help, and README guidance with the supported discovery and nested-workspace rules.
- Keep workspace discovery distinct from managed-checkout resolution so future clone and worktree modes can add mode-specific checkout contexts without redefining workspace identity.

## Capabilities

### New Capabilities
- `workspace-context`: Defines nearest-manifest discovery, fail-closed candidate handling, supported current-submodule context, and submodule-mode Git root validation.

### Modified Capabilities
- `init-onboarding`: Requires `oms init` to reject a target directory below an existing Git top-level before writing `oms.yaml`, while preserving initialization outside Git and existing onboarding output after successful scaffolding.

## Impact

- Affected code: workspace discovery and Git helpers, manifest loading, `oms init`, submodule command preflights, diagnostics, and CLI tests.
- Affected documentation: command location guidance and nested-workspace behavior in the README and relevant help text.
- Behavioral impact: commands fail earlier when `oms.yaml` is not a regular file or its directory conflicts with the root Git repository required by the current submodule-backed model.
- Future compatibility: no clone or worktree mode is introduced; the change only establishes a workspace-context boundary those modes can extend later.
