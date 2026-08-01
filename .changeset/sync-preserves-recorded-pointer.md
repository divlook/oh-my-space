---
"oh-my-space": minor
---

Preserve the root repository's recorded submodule pointer when `oms sync` encounters a newer baseline branch.

`oms sync <alias>` now attaches a detached submodule to its baseline only when the baseline is absent or already points at the checked-out commit. When the baseline tip has advanced without a matching `oms record`, sync leaves the submodule detached at the recorded commit, keeps the root gitlink clean, reports both commits, and prints explicit `oms branch switch <alias> <baseline>` and `oms pull <alias>` guidance.

This reverses the previous implicit-pull behavior for fresh initialization, pending-removal restoration, and initialized updates. Workflows that relied on `oms sync` to advance a submodule should use `oms pull` instead.

`oms sync` also stops echoing Git's own `submodule update --init` progress lines on success, printing them only when that step fails, so its report never repeats a source remote URL.

When Git refuses the branch operation altogether, `oms sync` now reports that alias as failed with Git's diagnostic and exits non-zero, where it previously reported the alias as added or updated. The eight commands that prepare a submodule working tree — `oms commit`, `oms fetch`, `oms pull`, `oms push`, and the four `oms branch` subcommands — now stop with the Git diagnostic when automatic initialization cannot attach the baseline branch, instead of silently continuing past the failed attachment.
