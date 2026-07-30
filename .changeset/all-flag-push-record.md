---
"oh-my-space": minor
---

Accept an optional alias list and `--all` on `oms push` and `oms record`, matching the selection model already used by `sync`, `status`, `fetch`, `pull`, and `unsync`.

`oms record` now takes several aliases and records them in one root commit: a single alias keeps `chore(oms): update <alias> submodule to <sha>`, while several use `chore(oms): update submodules`. A named alias that cannot be recorded still fails with its existing message and exit code; under `--all` such an alias is reported and skipped (exit 2) while the remaining moved pointers are recorded, and an alias whose pointer simply has not moved is skipped without affecting the exit code. The staged-path safety check is judged against the whole selection, so a staged gitlink for a skipped alias no longer blocks the rest of the run. After a `pull`/`push` that moves more than one pointer, the follow-up hint collapses into a single `oms record --all`.

Two invocations change. `oms push` with no arguments previously failed with a "missing required argument" usage error; it now resolves a selection interactively, or fails with an actionable message when stdin is not a TTY. And `oms sync`, `oms fetch`, `oms pull`, and `oms unsync` with no arguments in a non-interactive shell previously opened a prompt that could never be answered and died with Node's unsettled-top-level-await warning (exit 13); they now exit 1 naming `--all` or an explicit alias as the missing input.
