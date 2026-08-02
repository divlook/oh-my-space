# oh-my-space

[![npm version](https://img.shields.io/npm/v/oh-my-space.svg)](https://www.npmjs.com/package/oh-my-space)

`oh-my-space` (OMS) is a small CLI for managing multi-repository workspaces with Git submodules. Declare source repositories once, work in normal branches, and let the main project record the exact commit used from each repository.

## Who it helps

Use OMS when you:

- develop one product across several repositories and want them checked out side by side;
- need reproducible workspaces where the main project records each source repository's exact commit;
- want everyday branch, commit, pull, and push workflows without accidentally working in a detached checkout;
- want source-commit changes to remain visible until you deliberately record them in the main project;
- use AI coding tools that need a clear boundary between the main project and source repositories.

OMS keeps Git's reproducibility while automating routine submodule setup and bounded recovery. When a choice depends on your intent, it asks instead of changing repository state silently.

## Requirements

- [Node.js](https://nodejs.org) `>=20.19.0`
- Git `>=2.40`
- A Git repository whose top-level directory contains `oms.yaml` before repositories are synchronized

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

Synchronize the workspace and inspect its state:

```bash
oms sync --all
oms status
```

The source repository is now available at `oms/api/`. Continue with [Getting started](https://github.com/divlook/oh-my-space/blob/main/docs/getting-started.md) to complete the first branch, commit, push, and recorded-commit workflow.

## Documentation

- [Getting started](https://github.com/divlook/oh-my-space/blob/main/docs/getting-started.md) — set up a workspace and complete the first source change from branch creation through recording the commit in the main project.
- [How OMS works](https://github.com/divlook/oh-my-space/blob/main/docs/how-oms-works.md) — understand workspace layout, repository boundaries, recorded commits, synchronization, status, safety behavior, and recovery.
- [Commands](https://github.com/divlook/oh-my-space/blob/main/docs/commands.md) — choose the right command and Git scope; use `oms <command> --help` for exact arguments, options, and exit behavior.
- [Configure your workspace](https://github.com/divlook/oh-my-space/blob/main/docs/configure-your-workspace.md) — define repositories, remotes, and starting branches in `oms.yaml`.
- [AI coding tools](https://github.com/divlook/oh-my-space/blob/main/docs/ai-coding-tools.md) — install agent instructions and workspace skills that preserve repository boundaries.
- [Migration guides](https://github.com/divlook/oh-my-space/blob/main/docs/migrations/README.md) — follow version-specific upgrade instructions.
- [Development](https://github.com/divlook/oh-my-space/blob/main/docs/development.md) — build, test, and contribute to OMS.
- [Release channels](https://github.com/divlook/oh-my-space/blob/main/docs/release-channels.md) — install stable or beta releases and maintain npm release channels.

## License

[MIT](./LICENSE)
