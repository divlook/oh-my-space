---
"oh-my-space": patch
---

Fix `oms unsync` leaving orphaned state behind when several aliases are unsynced at once. The `.gitmodules` section and `.git/config` entry are now stripped explicitly instead of relying on `git rm`'s implicit edit, `.gitmodules` is removed once no submodule remains registered (rather than only when the file is byte-empty), and the empty `.git/modules/oms/` container is cleaned up. Failed aliases (for example a submodule with uncommitted or untracked changes) are now named at the end of the run so a buried failure isn't mistaken for success.
