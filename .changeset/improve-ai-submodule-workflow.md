---
"oh-my-space": minor
---

Add AI-assisted submodule workflow commands and make root pointer commits explicit.

- `oms status --json` emits one schema-versioned, machine-readable JSON object on stdout describing the workspace root, the current alias, root submodule pointers (`moved`/`staged`/`split`/`conflict`), and each submodule's branch, head, tracking branch, dirtiness, numeric ahead/behind, and pin. Both the JSON and the human-readable table now expose `missing` and `conflict` pins.
- `oms commit [alias] -m <message>` commits source changes inside the selected submodule only, never the root gitlink. It is staged-first (commits existing staged changes as-is, otherwise stages all with `git add -A`), supports repeated `-m`, and can infer the alias from the current `oms/<alias>/` directory.
- `oms record [alias]` commits an existing root gitlink pointer update for one alias as `chore(oms): update <alias> submodule to <sha>`, path-limited to `oms/<alias>` with strict index safety.
- `oms agent install|uninstall [--target agents|claude|both]` manages a marker-delimited (`<!-- OMS START -->` / `<!-- OMS END -->`) instruction block in the root-repository files `oms/AGENTS.md` and/or `oms/CLAUDE.md`, preserving content outside the markers and never staging the files.

BREAKING:

- `oms push --commit` is removed and `oms push --record` is unsupported. Both fail before pushing with guidance to run `oms push <alias>` and then `oms record <alias>`.
- `oms pull` and `oms push` no longer stage or commit the root gitlink. They synchronize only the submodule branch and print an `oms record <alias>` hint when the pointer moves. `oms pull` now rejects a dirty submodule; `oms push` warns but proceeds.
- `oms sync` and `oms unsync` no longer leave root topology changes staged. `.gitmodules` and `oms/<alias>` stay in the working tree, unstaged; create the topology commit through the interactive prompt or with `--commit` (`chore(oms): add submodule` / `chore(oms): remove submodule`).
