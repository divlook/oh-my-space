---
"oh-my-space": minor
---

Unify alias preparation across `oms commit`, `oms fetch`, `oms pull`, `oms push`, and the four `oms branch` operations.

Registered but uninitialized aliases are now initialized automatically before all eight commands continue, without creating or staging root topology. This makes invocations such as `oms pull api`, `oms commit api`, and `oms branch checkout api main` work directly after cloning a workspace instead of stopping at `Run "oms sync api" first`.

Declared but unregistered aliases now follow one bounded rule. `oms fetch`, `oms pull`, `oms branch list`, `oms branch switch`, and `oms branch checkout` offer to register and continue; acceptance creates one root topology commit, and a multi-alias fetch or pull asks once and registers the accepted set in one commit. Named aliases and sole candidates default to sync, while `--all` and multi-select default to skipping unregistered aliases. A chosen skip is reported and exits 0 while the remaining aliases continue.

`oms commit`, `oms push`, and `oms branch delete` continue to refuse unregistered aliases because a fresh clone cannot contain the local changes, unpushed commits, or deletable branch they require. Their errors now use the shared classifier and name `oms sync <alias>` without changing root state.

`oms commit`, `oms pull`, and `oms push` now attach a detached submodule `HEAD` automatically when a local branch already points at that commit. If attaching would move the working tree, interactive runs ask what to do and non-interactive runs stop with `oms branch switch` guidance.

Omitted alias selection for `oms commit`, `oms record`, `oms branch switch`, and `oms branch checkout` now depends on candidate count rather than terminal presence: zero candidates is a no-op, one candidate is selected automatically, and only genuine ambiguity requires a terminal.
