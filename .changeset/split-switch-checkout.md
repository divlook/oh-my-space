---
"oh-my-space": minor
---

Split `oms checkout` into two focused commands. `oms switch [alias] [branch]` manages LOCAL branches — switch to an existing one or create a new one (`--from <ref>` sets the start point), with no remote precondition and no upstream tracking. `oms checkout [alias] [branch]` fetches origin and checks out a REMOTE branch (`origin/*`) as a local tracking branch (or switches to an existing local counterpart). Both commands accept an omitted alias and/or branch and prompt interactively (synced submodules, and local or `origin/*` branches), failing fast on a non-interactive shell. BREAKING: `oms checkout <alias> <branch>` no longer creates a brand-new local branch — use `oms switch` for that. See docs/migrations/0.7.x-to-0.8.0.md.
