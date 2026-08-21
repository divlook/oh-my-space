---
"oh-my-space": minor
---

Add managed task trees: `oms tree add`, `oms tree list`, and `oms tree remove` create disposable per-task Git worktrees at `.oms-tree/<alias>/<task>/` on initialized submodules without root commits or `.gitmodules` changes. Alias-targeting commands refuse to run from inside a tree (use Git directly there), `oms unsync` refuses while trees exist, `oms status` gains a `trees` array, and `oms doctor` reports broken tree links and a missing local-exclude entry. The `oms-workspace` and `oms-branch` skills gain managed-tree guidance.
