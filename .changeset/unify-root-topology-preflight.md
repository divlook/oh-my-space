---
"oh-my-space": patch
---

Guard `oms unsync` with the same root-topology safety preflight as `oms sync`. It now refuses — with a deterministic message and a non-zero exit, before any `git submodule deinit`/`git rm`/`rmSync` — when the root gitlink is conflicted, a root Git operation (merge/rebase/cherry-pick/revert/bisect) is in progress, or `oms/<alias>` is occupied by a non-submodule file or directory.

**Behavioral change:** `oms unsync` no longer deletes a non-submodule path occupying `oms/<alias>` and no longer reports success in that state; it leaves the path untouched and fails. Previously it silently deleted the path and falsely reported `unsynced` with exit 0.

Internally, `unsync` and `oms record` are routed through a single shared preflight (`assertRootTopologySafe`) in the status spine so the guard set evolves in one place. `oms record`'s observable behavior, messages, and exit codes are unchanged.

The occupied-path guard now distinguishes a path that exists but cannot be read (permission or I/O error) from one occupied by non-submodule content. In that case `oms unsync` and `oms sync` report `oms/<alias> could not be read (permission or I/O error)` instead of telling you to "move or remove" a path you cannot access. `oms sync` still refuses in the same states with the same exit codes — only this message wording changes, in both its pending-removal restore and fresh-add branches.
