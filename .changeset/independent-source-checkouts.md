---
"oh-my-space": major
---

Manage source repositories as independent Git clones. Share repository declarations in `oms.yaml`; the workspace root no longer pins source commits. Replace `sync` and `unsync` with `clone` and `remove`, and remove `record`, registration commit options, and `autoCommitRegistration`. Status JSON uses schema version 2 and no longer reports root pointers.

For a workspace created with OMS 2.x, run `oms migrate --dry-run` before converting it. Migrate each computer separately to preserve its local Git data and working files. See the 2.x to 3.0.0 migration guide for rollout and recovery.
