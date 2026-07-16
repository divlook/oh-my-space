## Why

OMS can switch, check out, and delete branches inside submodules, but users still have to enter a nested repository and combine several Git commands to discover local and remote branch choices. This gap conflicts with OMS's automation-first product principle: routine work should complete inside OMS, human intervention should be requested only when a meaningful decision is required, and irrecoverable or dangerous failures should include a reason and an actionable remedy.

## What Changes

- Establish an OMS-wide automation-first CLI policy for new and changed workflows: handle normal cases automatically, offer choices when human judgment is required, and fail only when OMS cannot safely complete the work.
- Add `oms branch list [alias]` to select one submodule, prepare it when OMS can do so safely, refresh every remote declared for it in `oms.yaml`, and display its local and remote-tracking branches.
- Show decision-relevant local branch state: current and baseline flags, configured upstream, and ahead/behind counts.
- Keep remote discovery current automatically with `git fetch <remote> --prune`; retry a failed fetch once, continue through exhausted individual failures, and fall back to clearly marked cached refs so a usable list can still be produced, while redacting credentials from preserved Git diagnostics.
- Resolve an omitted alias through an interactive submodule selector when multiple declared aliases exist, while automatically selecting the only declared alias. In non-interactive use, a sole unregistered alias is selected only to provide exact sync guidance; multiple targets require an explicit alias.
- Automatically initialize a selected alias that already has safe root gitlink and `.gitmodules` registration, using the manifest URL when registration has URL drift without rewriting root metadata, reconcile its declared submodule-local remote configuration from `oms.yaml`, and refresh `origin/HEAD` when the manifest omits a baseline branch.
- Add `list` to the interactive bare `oms branch` action selector alongside `delete`.
- Preserve scope boundaries: listing itself does not switch branches, create missing root submodule topology, change root gitlinks, stage files, or create commits; automatic preparation is limited to local submodule initialization and configuration backed by existing root registration. Root topology and metadata may change only through an explicitly accepted delegation to the existing sync workflow.
- Provide a guided sync-or-cancel choice when an interactive user selects a declared alias with no root registration. Accepted sync retains its existing topology, metadata, and commit-or-unstage decisions before listing resumes. Fail only when the alias is unknown, non-interactive input is ambiguous, preparation is declined or impossible, or local branch state cannot be inspected safely, always with a reason and an actionable remedy.

## Capabilities

### New Capabilities

- `cli-automation-policy`: Defines the OMS-wide automation-first policy for automatic handling, guided decisions, and actionable terminal failures in new or changed workflows.

### Modified Capabilities

- `ai-submodule-workflow`: Adds automated local and declared-remote branch discovery through `oms branch list [alias]` and extends the interactive branch action selector.

## Impact

- CLI command registration and branch action selection in `scripts/oms.ts` and the branch command modules.
- Git inspection helpers for declared remote-tracking refs, upstreams, divergence, detached HEAD, and branch tips.
- Baseline resolution reused in a non-destructive reporting mode with explicit `known`, `incomplete`, or `unknown` state and unmatched reliable baseline names instead of blocking the list.
- Network access to every `oms.yaml`-declared remote for the selected submodule on each invocation, plus targeted initialization when existing root registration is not initialized.
- Human-readable CLI output, help, README command reference, workspace branch skill guidance, integration tests, and release notes.
- No new runtime dependency, manifest schema change, branch-list-owned root topology mutation, or breaking command syntax; any root mutation remains owned by explicitly accepted sync.
