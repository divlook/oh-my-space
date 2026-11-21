# Getting started

This guide starts with an empty project. It covers cloning the workspace sources and making your first branch, commit, and push.

## Requirements

- [Node.js](https://nodejs.org) `^24 || >=26`
- Git `>=2.40`
- A Git repository whose top-level directory will contain `oms.yaml`

Node 24 is the minimum supported line and the development, release, and required CI baseline.
Node 26 and later are permitted, but not every future version is verified.
The latest-runtime CI diagnostic is separate and non-gating.
If you use Node 20, 22, or 25, upgrade to Node 24 before installing the next major OMS release.
For example, with nvm:

```bash
nvm install 24
nvm use 24
```

`oms init` can create a manifest before you initialize Git. Before cloning sources, run `git init` in the same directory.

## Install OMS

Install `oh-my-space` globally with your package manager:

```bash
npm install -g oh-my-space
# or: pnpm add -g oh-my-space
# or: yarn global add oh-my-space
# or: bun install -g oh-my-space
```

## Create the workspace manifest

From the project root, create a starter manifest:

```bash
oms init
```

Edit `oms.yaml` so it declares the repositories you need. This example declares one repository:

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
repos:
  - alias: api
    remotes:
      origin: git@github.com:example/api.git
    branch: main # optional; defaults to the remote's default branch
```

See [Configure your workspace](configure-your-workspace.md) for the complete format and more examples.

## Clone the repositories

Clone every declared repository on its configured starting branch, called the baseline:

```bash
oms clone --all
```

Inspect the workspace state:

```bash
oms status
```

The repository is now available at `oms/api/`. Commit `oms.yaml` in the workspace root if you want to share the list. Each computer clones and updates its own copy; the workspace root does not pin source commits.

## Complete the first change

### 1. Start a local branch

```bash
oms branch switch api feature/login
```

Use `oms branch switch` to create or move to a local branch. To work from an existing remote branch, use `oms branch checkout` instead.

### 2. Edit and commit in the source repository

Make your changes under `oms/api/`.

Commit them inside that repository:

```bash
oms commit api -m "feat: add login"
```

This command commits only inside `oms/api/`. It does not change the root repository.

### 3. Push the source commit

```bash
oms push api
```

### 4. Confirm the workspace state

```bash
oms status
```

Check that `api` is on the branch you pushed and that its working files have no unexpected changes. The root may still show unrelated root changes, such as a manifest edit.

## Continue learning

- [How OMS works](how-oms-works.md) explains repository boundaries, synchronization, safety behavior, and recovery.
- [Commands](commands.md) helps you choose the correct command and Git scope.
- Run `oms <command> --help` for the authoritative arguments, options, examples, and exit behavior of a command.
