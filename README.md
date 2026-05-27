# oh-my-specs

An [OpenSpec](https://github.com/Fission-AI/OpenSpec) working space template for writing spec docs against external repositories.
Source repos are registered as Git submodules under `sources/<alias>/` and referenced read-only from specs.

## Requirements

- [Node.js](https://nodejs.org) 20.19.0+ (required by OpenSpec)
- [Bun](https://bun.sh) 1.2+ (uses native YAML import for the source submodule CLI)
- git

## Setup

Install OpenSpec globally and project dependencies:

```bash
bun install -g @fission-ai/openspec@latest   # one-time, OpenSpec CLI (or: npm install -g @fission-ai/openspec@latest)
bun install                                  # project deps for the sources CLI
```

OpenSpec is already initialized in this template (`openspec/` directory). For a fresh project, see the [OpenSpec quick start](https://github.com/Fission-AI/OpenSpec#quick-start) (`openspec init`).

## Quick start

```bash
bun run sources sync --list       # list registered source repos
bun run sources sync <alias>...   # add/init/update submodules by alias (space-separated)
bun run sources sync --all        # add/init/update every registered source repo
bun run sources sync              # interactive multi-select
bun run sources fetch <alias>...  # run git fetch --all --prune inside checked-out submodules
bun run sources pull --all        # run git pull --ff-only inside checked-out submodules
bun run sources push <alias>...   # run git push inside explicitly selected submodules
```

After `chmod +x scripts/sources.ts` you can also invoke it directly: `./scripts/sources.ts ...`.

## Managing source repositories

`sources.yaml` declares each source repo (`alias`, `url`, optional `branch`); checkouts live as Git submodules under `sources/<alias>/`.

| Command | Runs in | Does | Notes |
| --- | --- | --- | --- |
| `bun run sources sync <alias>` / `--all` | repo root | Adds missing submodules and initializes/updates registered ones. | Syncs `sources.yaml` to `sources/<alias>/`. |
| `bun run sources fetch ...` | selected checked-out submodule worktree | `git fetch --all --prune` | Does not change the superproject gitlink. |
| `bun run sources pull ...` | selected checked-out submodule worktree | `git pull --ff-only` | Requires a branch with upstream; detached HEAD/no-upstream states fail. |
| `bun run sources push <alias>...` | explicitly selected checked-out submodule worktree | `git push` | No `--all`, force push, or automatic upstream setup. |

To add a repo, add it under `repos:` in `sources.yaml`, run `bun run sources sync <alias>`, then commit `sources.yaml`, `.gitmodules`, and the gitlink change.

Standard Git submodule commands still work, e.g. `git submodule update --init --recursive`. VS Code + Red Hat YAML uses `sources.schema.json` for autocomplete/validation.

## Use as a template

Click **Use this template → Create a new repository** on GitHub to scaffold your own OpenSpec workspace. Then edit `sources.yaml` to point at the repos you want to analyze.

## License

[MIT](./LICENSE)
