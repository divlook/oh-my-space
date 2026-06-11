## Context

`oms` is published as the `oh-my-space` npm package with a single `oms` binary that points to `dist/oms.js`. The CLI already reads its own `package.json` version from the runtime package root and reads build metadata from `dist/build-info.json`.

The update command must change the currently installed CLI without accidentally mutating a user's project dependencies or a temporary package-runner cache. Installations may come from npm, pnpm, Yarn, or Bun, and may be global, project-local, temporary, or a development checkout.

## Goals / Non-Goals

**Goals:**

- Provide a first-party `oms update` command.
- Use the npm registry as the source of truth for the latest `oh-my-space` version.
- Detect the current installation context from runtime paths and package metadata.
- Automatically run an update command only for confident global installations.
- Show detected context and the exact package-manager command before mutation; `--yes` skips only the prompt.
- Provide non-mutating guidance for project-local, temporary, development, and unknown installations.

**Non-Goals:**

- Automatically edit a user's project `package.json` or lockfile.
- Update temporary `npx`, `pnpm dlx`, `yarn dlx`, or `bunx` caches.
- Support GitHub Releases, git tags, or any source other than the npm registry for latest-version checks.
- Add a background auto-update daemon or update check on every command.

## Decisions

### Use npm registry metadata for version discovery

`oms update` will fetch the latest version from the npm registry package endpoint for `oh-my-space`. This avoids depending on whichever package manager happens to be installed and keeps version discovery consistent across npm, pnpm, Yarn, and Bun users.

The lookup will use the public npm registry endpoint (`https://registry.npmjs.org/oh-my-space`) and `dist-tags.latest` as the source of truth. It will not parse user package-manager registry configuration or private registry settings. The lookup will use Node's built-in `fetch` with a timeout so update checks do not hang indefinitely.

Version comparison will use the `semver` package. Invalid current or latest versions are treated as failures and never trigger an automatic update. If the installed version is equal to the registry latest version, the command exits successfully without installation-context detection. If the installed version is newer than the registry latest version, the command reports that state and exits successfully without downgrading.

Alternatives considered:

- `npm view oh-my-space version`: simple but requires npm in PATH even when the user installed with another manager.
- GitHub Releases or tags: less directly tied to the package users install.
- Private registry or package-manager config lookup: useful for enterprise mirrors, but requires manager-specific config resolution and is out of scope for the first implementation.

### Separate detection from execution

The command will first build an install-context model, then select an update strategy. Detection will inspect the real path of the running CLI, the runtime package root, package metadata, PATH-resolved `oms` binary, and package-manager-specific path patterns.

Expected context categories:

- `global`: persistent global package installation with a known package manager.
- `project`: persistent project-local dependency.
- `ephemeral`: one-shot runner such as npx, pnpm dlx, yarn dlx, or bunx.
- `development`: repository checkout or unpacked development build.
- `unknown`: insufficient or conflicting evidence.

Only `global` with enough confidence receives an executable update strategy. The confidence bar is intentionally moderate: the runtime package root must be verified as `oh-my-space`, and the package root must match a known global package-manager layout. PATH-resolved `oms` mismatches are reported as warnings but do not block automatic update by themselves. If package-manager evidence conflicts or no single manager can be selected, the context becomes `unknown` and receives guidance only.

Path classification will prefer real paths over symlink or shim paths, while still collecting the original invoked path and PATH-resolved binary for diagnostics. Common global layouts for npm, pnpm, Yarn classic, and Bun are supported. Environment-manager shims such as Volta, asdf, mise, or nvm are not enough by themselves to classify a global install. However, installs under environment-manager-controlled directories are allowed when the real package root, executable path, and package-manager layout prove a persistent global installation with a single selected package manager. For example, a prefix-local `bin/oms` pointing to `lib/node_modules/oh-my-space/dist/oms.js` is classified as npm global when the prefix relationship is clear, regardless of whether that prefix is managed by nvm, asdf, mise, or another Node environment manager. If an environment manager uses a custom store or shim model that does not clearly map to the selected package-manager update command, the context remains `unknown`. Yarn automatic update support is limited to clearly detected Yarn classic global installs.

Project-local guidance will inspect the nearest project `package.json` when available. The `packageManager` field has priority over lockfile evidence, and `dependencies` versus `devDependencies` determines whether the suggested command uses a dev flag. Unknown or special dependency locations fall back to dev-dependency guidance.

Ephemeral detection is path-pattern based. Environment variables are not sufficient by themselves to classify `npx`, `pnpm dlx`, `yarn dlx`, or `bunx` execution. Development checkouts are detected from repository files and repo-local execution paths, and they receive minimal non-mutating guidance.

### Treat project-local installs as guidance-only

Project-local updates can modify a user's application dependency manifest and lockfile. That is a broader project mutation than users usually expect from a CLI self-update command, so `oms update` will not execute project-local package-manager commands by default.

The command may still identify the likely project manager and print an example command such as `pnpm add -D oh-my-space@latest` when enough evidence exists.

### Confirm before mutating global installs

Interactive `oms update` will show the current version, latest version, detected context, and exact update command before running it. `--yes` bypasses confirmation only when a confident global update command is available.

`--check` will never mutate and exits after reporting whether an update is available.

When `--check` and `--yes` are provided together, `--check` wins and the command remains non-mutating. If an update is available, `--check` also reports whether automatic update would be available for the detected context. If no update is available, context detection is skipped.

Interactive confirmation requires an explicit yes/no choice with no default selection. Declining or cancelling exits successfully without mutation. In non-interactive environments, `oms update` without `--yes` prints the selected command and instructs the user to rerun with `--yes`; it does not prompt, fail, or mutate.

`--yes` skips only the prompt. It still prints the current version, latest version, detected context, and selected command before execution. In project-local, ephemeral, development, or unknown contexts, `--yes` refuses automatic mutation, prints safe guidance, and exits successfully.

### Keep command execution local and transparent

The update process will spawn the detected package manager command with inherited stdio so users see native package-manager output. POSIX execution uses `shell: false`; Windows uses shell execution so `.cmd` and `.bat` package-manager shims resolve through `cmd.exe`. Displayed commands are human-readable strings derived from the same executable and argument model.

Global update commands use reinstall-style `@latest` commands:

- npm: `npm install -g oh-my-space@latest`
- pnpm: `pnpm add -g oh-my-space@latest`
- Yarn classic: `yarn global add oh-my-space@latest`
- Bun: `bun add -g oh-my-space@latest`

The package-manager binary is checked with a lightweight `manager --version` execution before mutation. If the detected manager is not executable from PATH, the command fails with exit code `1` and prints the command that would have run. Package-manager failures are normalized to `oms` exit code `1`; the child status or signal is included in the error summary.

After a successful package-manager command, `oms` runs `oms --version` from PATH as a best-effort post-update diagnostic. A mismatch or verification failure is reported as a warning but does not turn a successful package-manager update into a failure.

Install commands do not force `--registry=https://registry.npmjs.org`. Version discovery uses the public registry, while actual installation follows the user's package-manager configuration.

### Exit codes

`oms update` will stay within the existing CLI exit-code convention instead of introducing command-specific codes:

- `0`: successful check, already current, user declined or cancelled, unsupported automatic update with guidance, or successful package-manager update.
- `1`: usage/config/runtime failure such as registry lookup failure, invalid semver, missing detected package manager, or package-manager execution failure.
- `2`: reserved for existing warning/partial-failure semantics; self-update should not introduce new uses unless an implementation-specific partial-success case appears.

State distinctions such as update available, unsupported automatic update, declined, and verification warning are communicated through output rather than dedicated exit codes.

### Testability

CLI tests will run through the built `dist/oms.js` and avoid real registry access or real global package-manager mutation. Non-public `OMS_TEST_*` hooks may control registry payloads, runtime paths, PATH resolution, spawn results, and post-update verification, but only when `OMS_TEST_MODE=1` is set. These hooks are test-only implementation details and are not documented in README.

## Risks / Trade-offs

- Misdetecting global vs project installation could mutate the wrong environment. -> Require verified package metadata and known global layout evidence before execution; otherwise print guidance only.
- Package-manager global layouts vary across versions and environment managers. -> Use multiple evidence signals instead of one path pattern, and make `unknown` a normal supported outcome.
- Network access to the npm registry can fail. -> Surface a clear error and avoid mutation when the latest version cannot be determined.
- Version comparison can be wrong if implemented as string comparison. -> Use the `semver` package for published versions.
- `--yes` can run unattended updates. -> Allow it only for confident global installs and print the selected command before execution.
- Public-registry lookup and package-manager install can disagree when a user configures a private registry. -> Do not force install registry settings; surface package-manager failures normally.
