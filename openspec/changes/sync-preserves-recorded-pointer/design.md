## Context

`oms sync` initializes registered submodules with `git submodule update --init`, which checks out the root repository's recorded gitlink commit in detached `HEAD`. It then calls `attachBranch`. When the baseline branch already exists locally, `attachBranch` currently switches to it without comparing its tip to `HEAD`.

A clone commonly creates that local baseline at the remote tip. If the remote advanced without a corresponding `oms record`, the baseline tip differs from the recorded gitlink. Switching to it silently advances the submodule, dirties the root gitlink, and defeats sync's reproducibility promise.

The shared preparation path added a local guard around `attachBranch`, but the four sync call sites still use the unsafe primitive directly. The safety rule belongs in `attachBranch` so every caller gets one answer.

The four sync call sites have different reachability:

| Call site | Drifted existing baseline reachable? | Reason |
| --- | --- | --- |
| pending-removal restore | yes | initialization restores the recorded commit while retained local refs may point elsewhere |
| fresh add | no | `git submodule add -b` creates and checks out the new registration at the selected remote branch |
| registered initialization | yes | initialization checks out the recorded gitlink while the cloned baseline may be at the remote tip |
| initialized update | yes | a user may be detached at a recorded or deliberate commit while the baseline points elsewhere |

## Goals / Non-Goals

**Goals:**

- Make every detached-HEAD attachment preserve the checked-out commit.
- Keep a registered initialization at the root repository's recorded gitlink when its baseline has advanced.
- Report a declined attachment as a successful, intentionally detached sync result with actionable guidance.
- Remove the duplicate tip comparison from alias preparation.
- Preserve current behavior when already attached, when the baseline is absent, or when its tip equals `HEAD`.

**Non-Goals:**

- Advancing a submodule to the remote tip; that remains `oms pull` or an explicit branch switch.
- Changing preparation behavior for the eight submodule-working-tree commands.
- Repairing partial registration, changing topology finalization, or changing baseline resolution.
- Treating a safe detached result as a sync failure.

## Decisions

### 1. `attachBranch` owns the no-movement invariant

`attachBranch` will compare the full `HEAD` commit OID with the existing local baseline tip before switching:

- already attached: preserve the current branch and return `already-attached`
- baseline absent: create it at `HEAD`, configure upstream when available, and return `attached`
- baseline tip equals `HEAD`: switch as a pure relabel and return `attached`
- baseline tip differs from `HEAD`: do not switch and return `diverged` with both OIDs
- Git cannot create or switch the branch: return `failed`

A discriminated result is preferred over a boolean because sync must distinguish an intentional divergence from an operational Git failure. Keeping the comparison in alias preparation was rejected because it leaves the unsafe primitive available to every other caller and duplicates the same OID rule.

### 2. Divergence is successful and explicit

A diverged baseline leaves the submodule detached at its current commit and does not change the root gitlink. Sync reports a note naming the baseline and abbreviated current/baseline OIDs, then points to:

- `oms branch switch <alias> <baseline>` to move deliberately to the existing baseline tip
- `oms pull <alias>` after attaching when the user wants remote advancement

The alias operation remains successful. Detached `HEAD` at the recorded pointer is the reproducible result sync was asked to restore; converting it to exit 2 would misclassify preserved correct state as an operation failure. Silently omitting the attachment was rejected because users would otherwise interpret the detached checkout as an accidental incomplete sync.

### 3. Sync call sites use one reporting wrapper

`repo-ops.ts` will wrap `attachBranch` in one helper that converts its result into sync logging and operation success or failure. All four call sites use that wrapper, even though fresh add cannot currently reach `diverged`; retaining the call keeps the invariant local if Git's clone behavior or the add path changes later.

A `failed` attachment remains an operation failure with the original Git diagnostic and preserved-state guidance. A `diverged` attachment is reported and continues. This prevents each call site from inventing its own exit-code policy.

### 4. Shared preparation delegates to the same primitive

`initializeRegisteredAlias` will delete its inline `localBranchOid`/`HEAD` comparison and call `attachBranch` directly. A `diverged` result leaves `HEAD` detached so the command's existing detached-HEAD handling can either continue safely (`fetch`), collect intent (`commit`, `pull`, `push`), or perform the requested branch action (`branch switch`, `branch checkout`).

### 5. Regression coverage reproduces remote-tip drift

The load-bearing fixture records submodule commit A in the root, advances `origin/main` to commit B without recording it, clones the root repository, and runs `oms sync api`. It must assert:

- submodule `HEAD` remains A
- the submodule is detached
- the root gitlink and index remain clean
- output identifies that `main` points at B and gives explicit branch/pull guidance
- exit status is 0

Companion cases cover a missing baseline created at `HEAD`, an existing baseline at `HEAD` attached as a pure relabel, and an attachment Git failure remaining non-zero.

## Risks / Trade-offs

- [Behavior change] Workflows that used `oms sync` as an implicit pull will stop advancing. Mitigation: output names the deliberate switch and pull commands, README clarifies the boundary, and the minor changeset names the reversal.
- [Detached checkout remains visible] Some tools treat detached `HEAD` as undesirable even when it is the recorded state. Mitigation: sync explains why it stayed detached and provides explicit recovery without sacrificing reproducibility.
- [Result propagation] Changing `attachBranch` from `void` requires auditing every caller. Mitigation: TypeScript exhaustiveness and one sync wrapper make ignored outcomes compile-visible; the four call sites are enumerated above.
- [OID lookup failure] A missing or unreadable `HEAD` prevents a safe comparison. Mitigation: fail closed as `failed`; never switch when equality cannot be proven.
