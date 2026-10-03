# oh-my-space

[![npm version](https://img.shields.io/npm/v/oh-my-space.svg)](https://www.npmjs.com/package/oh-my-space)

`oh-my-space` (OMS) manages multi-repository workspaces with Git submodules. Source repositories use normal branches. The main project records each source repository's exact commit.

## Who it helps

Use OMS when you:

- develop one product across several repositories and need adjacent checkouts.
- need reproducible workspaces with exact source commits recorded in the main project.
- need branch, commit, pull, and push workflows that avoid accidental detached checkouts.
- need source-commit changes to remain visible until you record them in the main project.
- use AI coding tools that need a clear boundary between the main project and source repositories.

OMS preserves Git's reproducibility and automates routine submodule setup and bounded recovery. OMS asks when a choice depends on your intent.

## Requirements

- [Node.js](https://nodejs.org) `>=20.19.0`
- Git `>=2.40`
- A Git repository with `oms.yaml` at its top level before you synchronize repositories

## Install

Install the `oms` command globally with your package manager:

```bash
npm install -g oh-my-space
# or: pnpm add -g oh-my-space
# or: yarn global add oh-my-space
# or: bun install -g oh-my-space
```

## Quick start

Create a manifest at your project root:

```bash
oms init
```

Declare one repository in `oms.yaml`:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
repos:
  - alias: api
    remotes:
      origin: git@github.com:example/api.git
    branch: main # optional; defaults to the remote's default branch
```

Synchronize the workspace:

```bash
oms sync --all
```

Inspect its state:

```bash
oms status
```

The source repository is now available at `oms/api/`. Follow [Getting started](https://github.com/divlook/oh-my-space/blob/main/docs/getting-started.md) for your first branch, commit, push, and recorded-commit workflow.

## Documentation

- [Getting started](https://github.com/divlook/oh-my-space/blob/main/docs/getting-started.md): Read for workspace setup and your first source change.
- [How OMS works](https://github.com/divlook/oh-my-space/blob/main/docs/how-oms-works.md): Read for layout, repository boundaries, recorded commits, managed trees, synchronization, status, safety, and recovery.
- [Commands](https://github.com/divlook/oh-my-space/blob/main/docs/commands.md): Read to choose a command and Git scope. Use `oms <command> --help` for exact arguments, options, and exit behavior.
- [Configure your workspace](https://github.com/divlook/oh-my-space/blob/main/docs/configure-your-workspace.md): Read to define repositories, remotes, and starting branches in `oms.yaml`.
- [AI coding tools](https://github.com/divlook/oh-my-space/blob/main/docs/ai-coding-tools.md): Read to install agent instructions and workspace skills that preserve repository boundaries.
- [Migration guides](https://github.com/divlook/oh-my-space/blob/main/docs/migrations/README.md): Read for version-specific upgrade instructions.
- [Development](https://github.com/divlook/oh-my-space/blob/main/docs/development.md): Read to build, test, or contribute to OMS.
- [Release channels](https://github.com/divlook/oh-my-space/blob/main/docs/release-channels.md): Read to install stable or beta releases or maintain npm release channels.

## License

[MIT](./LICENSE)
