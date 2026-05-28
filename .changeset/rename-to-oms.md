---
"oh-my-space": minor
---

**Breaking**: rename the manifest from `sources.yaml` to `oms.yaml` and the data directory from `sources/` to `oms/`. CLI commands (`oms sync`, `oms worktree …`) are unchanged but disk layout and the `.gitignore` entry move, so each workspace needs a one-time manual migration. When the old names are detected the CLI aborts and points at the new [`docs/migrations/0.3.x-to-0.4.0.md`](https://github.com/divlook/oh-my-space/blob/main/docs/migrations/0.3.x-to-0.4.0.md) guide. The schema file is renamed to `oms.schema.json`, the README's inline migration sections are moved into `docs/migrations/`, and `package.json` keywords/description are refreshed.
