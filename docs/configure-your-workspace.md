# Configure your workspace

`oms.yaml` declares the source repositories that belong in the workspace. Keep it at the top level of the main Git repository.

## Start a manifest

Run this from the intended workspace root:

```bash
oms init
```

`oms init` writes a starter manifest. It does not add repositories or install AI tooling. If the directory is not already a Git root, run `git init` there before cloning sources.

## Manifest structure

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
repos:
  - alias: service-a
    remotes:
      origin: git@github.com:example/service-a.git
    branch: main
  - alias: docs
    remotes:
      origin: https://github.com/example/docs.git
      upstream: https://github.com/upstream/docs.git
```

The schema comment is optional at runtime. Keep it to enable editor validation and completion from [`oms.schema.json`](../oms.schema.json).

## `repos`

The manifest must contain a non-empty `repos` array. Each entry declares one source repository.

### `alias`

Each entry must specify a unique `alias`. OMS places the repository checkout at `oms/<alias>/`.

An alias:

- starts with an ASCII lowercase letter or digit.
- continues with ASCII lowercase letters, digits, `-`, `_`, or `@`.
- cannot contain uppercase letters, `/`, `\`, `.`, or whitespace.

The accepted pattern is `/^[a-z0-9][a-z0-9_@-]*$/`.

### `remotes`

Each entry must specify `remotes` that contain `origin`. Each value is a Git URL that supports cloning.

`origin` is the primary remote. OMS uses it when cloning. The origin of an existing checkout must match this value after Git applies fetch URL rewriting. OMS adds the other declared remotes, such as `upstream`, when it clones a source.

OMS never prints remote URL values while reporting metadata changes.

### `branch`

`branch` is optional. It names the starting branch, called the baseline, to clone from `origin`. Omit it to use the remote's default branch.

OMS uses the baseline to protect important branches from deletion. Updating the declaration does not switch or advance an existing checkout.

## Common examples

### One repository using the remote default branch

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
repos:
  - alias: api
    remotes:
      origin: git@github.com:example/api.git
```

### Fork with an upstream remote

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
repos:
  - alias: web
    remotes:
      origin: git@github.com:your-name/web.git
      upstream: git@github.com:organization/web.git
    branch: main
```

## Apply configuration changes

After editing the manifest, clone any missing sources:

```bash
oms clone --all
```

Inspect the workspace state:

```bash
oms status
```

`oms clone` leaves verified existing clones unchanged. If you reuse an alias for a different origin, move the previous checkout somewhere safe first. OMS does not replace it.

Use `oms remove` to remove a local checkout while keeping its declaration. To change what the team shares, edit and commit `oms.yaml` in the root.

See [How OMS works](how-oms-works.md#synchronization) for provisioning and recovery behavior.
