# Refactoring decisions

This document records why OMS keeps certain responsibilities separate and which exceptions are intentional. See [Development](development.md#find-the-owning-module) for module ownership and [How OMS works](how-oms-works.md) for command behavior.

## Keep observation, selection, and mutation separate

Shared observations sit below commands so a change to `status` output cannot change a write-safety decision. Selection does not initialize or register a checkout. Preparation calls synchronization with an explicit workspace root and selected declarations, rather than rediscovering a workspace from the current directory. It passes the redacting Git runner explicitly instead of changing process-wide state.

- The nearest manifest is authoritative even when invalid. Commands that inspect or mutate submodules require that manifest directory to be the Git root. Legacy layouts and managed trees retain their own refusal rules so commands do not act on the wrong checkout.
- Explicit and widened selections keep different defaults. Destructive confirmation defaults to No. Preparation can offer registration once per batch, but commands that require existing local work refuse a fresh registration. Accepting a pending registration is a separate decision from offering a new one.
- Source commits honor existing staging and do not record root pointers. Synchronization preserves the recorded source commit; a detached checkout can attach automatically only at the same commit. Pull and push carry the resolved branch name through to Git so a tag, significant whitespace, or a name such as `--all` cannot redirect the operation.

## Share Git reads only within one inspection

Status and multi-alias preparation batch reads to avoid repeated Git subprocesses. A failed batch falls back to per-alias inspection so one unreadable result does not suppress healthy aliases. Observations are not cached across confirmation, initialization, delegated synchronization, or mutation: those steps can change the facts the next decision depends on.

- Strict branch cleanup refuses incomplete or ambiguous evidence. Reporting can still show reliable observations alongside failures; single-branch deletion retains its existing permissive probes. Baseline drift protects every reliably resolved baseline. Cleanup registration and preparation keep distinct policies because they require different evidence.
- A cleanup plan can become stale while the user is deciding or while earlier candidates are processed. Execution rechecks safety and candidate identity before each deletion and verifies the displayed commit IDs in the ref transaction. A configuration cleanup failure does not undo a completed ref deletion. These safeguards are not a general lock against concurrent Git activity.

## Keep root commits scoped and recoverable

Working-file reconciliation and root commit synthesis share the same `.gitmodules` edits but start from different content. A root commit uses recorded content so it cannot pick up unrelated working-file edits. Add and remove workflows retain separate partial-success rules because the effects they can safely finalize differ.

Root finalization batches literal-path reads within each phase, caps batch size for subprocess argument limits, and stops on a failed batch. It keeps the lock, index hash, expected HEAD, and durable recovery marker checks because HEAD can advance before the replacement index is installed. The existing marker format and lock limitations still apply. Bounded fetch, lock, index-install, metadata-install, and chmod retries remain operation-specific; best-effort cleanup must not hide the primary failure.

## Keep external tooling failures in scope

- Ordinary updates validate the stable tag independently of beta compatibility checks: a malformed beta tag must not block a stable update. Automatic mutation is limited to confidently identified global installs.
- Skill installation and discovery share a repository identity so they cannot drift apart. External lock metadata is optional and filesystem discovery retains first-match precedence. Missing package-manager guidance does not block compatibility inspection, and skill diagnostics do not change `doctor`'s exit status.
- Agent instruction edits validate every selected file before applying any edit, so one malformed marker leaves all targets unchanged. This is not a rollback guarantee if a later write fails. Outside content and Git staging are left untouched; an empty file may be removed.

## Keep verification tied to the behavior it protects

- Beta preparation and verification fingerprinting share the same metadata transformation. Temporary metadata stays in place until child processes finish, including on interruption. Bundle license collection uses physical package roots so nested dependency versions are not collapsed. [Release channels](release-channels.md) documents the remaining publication and recovery constraints, including the cache-miss beta limitation.
- Each test file owns the contracts it runs; literal registration names let the inventory reject unsupported forms rather than silently miss tests. Black-box contracts require an explicit reason to use the production process, such as crash recovery, streaming, interruption, or bundle wiring. Platform and permission skips remain only where the environment cannot exercise the contract.
- The standalone integration layer builds the CLI because its shared seed uses the real `sync` command. The canonical gate already builds before preparing that seed, so it does not build again.

Performance evidence lives separately in [CLI inspection measurements](../tests/performance/untangle-inspection.json) and [suite benchmarks](../tests/performance/suite-benchmarks.json).
