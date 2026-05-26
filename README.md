# oh-my-specs

An [OpenSpec](https://github.com/Fission-AI/OpenSpec) working space template for writing spec docs against external repositories.
Source repos are cloned under `sources/<alias>/` and referenced read-only (`sources/*` is gitignored).

## Requirements

- [Node.js](https://nodejs.org) 20.19.0+ (required by OpenSpec)
- [Bun](https://bun.sh) 1.2+ (uses native YAML import for the clone CLI)
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
bun run clone --list           # list registered repos
bun run clone <alias>...       # clone by alias (space-separated)
bun run clone --all            # clone every registered repo
bun run clone                  # interactive multi-select
```

After `chmod +x scripts/clone.ts` you can also invoke it directly: `./scripts/clone.ts ...`.

## Sources

- Aliases, URLs, and optional `branch` are managed in `sources.yaml`.
- To add a new repo, append an entry under `repos:` and run the CLI above.
- VS Code + the Red Hat YAML extension picks up `sources.schema.json` for autocomplete/validation.

## Use as a template

Click **Use this template → Create a new repository** on GitHub to scaffold your own OpenSpec workspace. Then edit `sources.yaml` to point at the repos you want to analyze.

## License

[MIT](./LICENSE)
