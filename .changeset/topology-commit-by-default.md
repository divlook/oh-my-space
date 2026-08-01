---
"oh-my-space": minor
---

Create the root topology commit by default in `oms sync` and `oms unsync`, and decide it identically whether or not stdin is a terminal.

Previously the topology commit happened only with `--commit` or an accepted interactive prompt, and that prompt was gated on `process.stdin.isTTY`. In a terminal it appeared and defaulted to Yes, so the commit was normally created; in a pipe it was skipped entirely, the topology was left unstaged, and the command still exited 0. Identical repository state produced opposite results based on the terminal alone, and the non-interactive path left a required follow-up that `oms status` reported as `Run "oms sync <alias> --commit"`.

The default now lives in `finalizeTopology` rather than in the command-line flag, so it holds for piped shells and for internal callers that delegate to sync without passing an option.

BREAKING: `oms sync <alias>` and `oms unsync <alias>` now create a root commit where they previously left `.gitmodules` and the selected gitlinks unstaged. Pass `--no-commit` to keep the previous behavior. `--commit` is accepted for compatibility and produces exactly the default, so invocations that already passed it are unaffected. The interactive "Create a root topology commit?" prompt is removed; it defaulted to Yes, so accepting it was already the normal path. A workflow that ran several syncs and then hand-authored one commit will now produce one commit per invocation — use `oms sync api web` for a single combined commit, or `--no-commit` to keep hand-authoring. See `docs/migrations/0.14.x-to-0.15.0.md`.

Fixes `oms branch list <alias>` failing on its own second invocation. Preparing an unregistered alias delegates to sync, which left the topology uncommitted and put the alias into a partially-registered state; the next `oms branch list <alias>` then exited 1 with `root gitlink and .gitmodules registration are inconsistent or pending addition/removal`. The delegated sync now commits its topology, so repeating the command succeeds.

Every safety refusal is unchanged: partial removal topology is still rejected, an unsync commit still refuses unrelated staged root paths, a partially failed unsync still leaves successful topology unstaged, and a partially failed sync still finalizes only the successful aliases through the temporary index.
