---
"oh-my-space": patch
---

`oms doctor` now warns when the installed git is older than 2.40. The new model uses `git worktree add --track -B <branch> <branch> origin/<branch>` and older git versions can produce cryptic failures from `oms sync`/`worktree add` instead of a clear diagnostic. Detection is best-effort: if `git --version` output can't be parsed, doctor warns and continues.
