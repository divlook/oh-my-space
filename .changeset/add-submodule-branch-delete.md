---
"oh-my-space": minor
---

Add `oms branch delete [alias] [branch]` to remove a local branch inside one initialized submodule. It is local-only (never deletes a remote or remote-tracking ref, never touches the root gitlink), protects the current branch and every resolved baseline (explicit `oms.yaml` branch, `origin/HEAD` default, or a recorded `.gitmodules` branch) even under `--force`, uses a safe delete by default with one guarded force retry, and prints the branch tip's full OID and a shell-safe recreation command before any force deletion.

`oms sync` now reconciles OMS-managed `.gitmodules` metadata declaratively from `oms.yaml` (authoritative `remotes.origin` URL and explicit-or-removed `branch`) and finalizes topology and metadata through one durable, recoverable commit decision. Compatibility note: sync is stricter — an omitted baseline now requires a resolvable `origin/HEAD`, an explicit baseline must exist on `origin`, managed URL/branch drift is overwritten from the manifest, mismatched staged OMS paths are rejected, every sync commit includes the complete working-tree `oms.yaml`, an explicit partial `sync --commit` commits the successful aliases, and `sync`/`unsync`/`record` run a recovery preflight that can stop on interrupted finalization state. See `docs/migrations/0.11.x-to-0.12.0.md`.
