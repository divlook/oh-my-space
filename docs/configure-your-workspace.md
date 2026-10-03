# Configure your workspace

`oms.yaml` declares the source repositories that belong in the workspace. Keep it at the top level of the main Git repository.

## Start a manifest

Run this from the intended workspace root:

```bash
oms init
```

`oms init` writes a starter manifest. It does not add repositories or install AI tooling. Before running submodule commands, run `git init` in the same directory if it is not a Git root.

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

`origin` is the primary remote. During synchronization, it controls the local `origin` URL and the matching `.gitmodules` URL. OMS processes additional entries, such as `upstream`, as additional remotes in manifest order.

OMS never prints remote URL values while reporting metadata changes.

### `branch`

`branch` is optional. When present, it names the baseline branch that synchronization validates on `origin`. When omitted, OMS uses the remote's default branch (`origin/HEAD`) as the baseline.

The baseline guides synchronization and protects important branches from deletion. Synchronization does not silently move a checkout from the commit recorded by the main project to a newer baseline commit.

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

After editing the manifest, reconcile the workspace:

```bash
oms sync --all
```

Inspect the workspace state:

```bash
oms status
```

`oms sync` adds missing registrations and updates OMS-managed `.gitmodules` metadata. It commits registration and metadata changes by default. Run `oms sync --help` before choosing a different finalization mode.

To remove a checked-out repository while keeping its declaration for later use, use `oms unsync`. To remove it from the workspace definition, edit `oms.yaml` as a separate main-project change.

See [How OMS works](how-oms-works.md#synchronization) for baseline, recorded-commit, partial-success, and recovery behavior.
