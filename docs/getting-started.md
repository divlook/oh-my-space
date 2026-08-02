# Getting started

This guide takes you from an empty project to a synchronized workspace, then through one complete branch, commit, push, and record workflow.

## Requirements

- [Node.js](https://nodejs.org) `>=20.19.0`
- Git `>=2.40`
- A Git repository whose top-level directory will contain `oms.yaml`

`oms init` can create a manifest before Git is initialized. Before synchronizing repositories, run `git init` in the same directory.

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

## Synchronize the repositories

Add and initialize every declared repository on its configured starting branch, called the baseline:

```bash
oms sync --all
oms status
```

The repository is now available at `oms/api/`. The main project records its exact commit, while `oms/api/` remains a normal Git working tree where you can create branches and make commits.

## Complete the first change

### 1. Start a local branch

```bash
oms branch switch api feature/login
```

Use `oms branch switch` to create or move to a local branch. To work from an existing remote branch, use `oms branch checkout` instead.

### 2. Edit and commit in the source repository

Make your changes under `oms/api/`, then commit them inside that repository:

```bash
oms commit api -m "feat: add login"
```

This command commits only inside `oms/api/`. It does not commit the changed repository reference in the main project.

### 3. Push the source commit

```bash
oms push api
```

Push before recording the new commit in the main project. Other users must be able to fetch the source commit that the main project records.

### 4. Record the new commit in the main project

```bash
oms record api
```

A Git submodule stores an exact source-repository commit in the main project. OMS calls this the **recorded commit**. `oms record` commits the updated recorded commit in the main project without including unrelated paths.

### 5. Confirm both repositories are in the expected state

```bash
oms status
```

A `moved` pointer means the checked-out source commit differs from the commit recorded by the main project. Push the source commit if needed, then run `oms record <alias>`.

## Continue learning

- [How OMS works](how-oms-works.md) explains repository boundaries, synchronization, safety behavior, and recovery.
- [Commands](commands.md) helps you choose the correct command and Git scope.
- Run `oms <command> --help` for the authoritative arguments, options, examples, and exit behavior of a command.
