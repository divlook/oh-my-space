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
bun install                                  # project deps for the clone CLI
```

OpenSpec is already initialized in this template (`openspec/` directory). For a fresh project, see the [OpenSpec quick start](https://github.com/Fission-AI/OpenSpec#quick-start) (`openspec init`).

## Quick start

```bash
bun run clone --list           # list registered source repos
bun run clone <alias>...       # add/update submodules by alias (space-separated)
bun run clone --all            # add/update every registered source repo
bun run clone                  # interactive multi-select
```

After `chmod +x scripts/clone.ts` you can also invoke it directly: `./scripts/clone.ts ...`.

## Sources

- Aliases, URLs, and optional `branch` are managed in `sources.yaml`.
- Running the CLI registers each source repo as a Git submodule at `sources/<alias>/`.
- Re-run `bun run clone <alias>` or `bun run clone --all` to initialize/update registered submodules.
- Standard Git submodule commands also work, for example: `git submodule update --init --recursive`.
- To add a new source repo, append an entry under `repos:` and run the CLI above. Commit both `sources.yaml` and Git's generated `.gitmodules`/gitlink changes.
- VS Code + the Red Hat YAML extension picks up `sources.schema.json` for autocomplete/validation.

## Use as a template

Click **Use this template → Create a new repository** on GitHub to scaffold your own OpenSpec workspace. Then edit `sources.yaml` to point at the repos you want to analyze.

## License

[MIT](./LICENSE)
