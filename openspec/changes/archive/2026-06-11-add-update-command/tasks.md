## 1. Version and Registry Lookup

- [x] 1.1 Add a registry lookup helper that fetches the latest `oh-my-space` version from the npm registry.
- [x] 1.2 Add `semver` and `@types/semver`, then compare current vs registry `dist-tags.latest` with semver.
- [x] 1.3 Handle registry network, HTTP, JSON, and missing-version failures without running update commands.
- [x] 1.4 Treat invalid current/latest semver as failures and treat current-newer-than-latest as a non-mutating success.

## 2. Installation Context Detection

- [x] 2.1 Add install-context types for global, project, ephemeral, development, and unknown installations.
- [x] 2.2 Detect the runtime package root and verify it belongs to the `oh-my-space` package.
- [x] 2.3 Inspect the real running binary path, PATH-resolved `oms` binary, package root, and package-manager path patterns.
- [x] 2.4 Classify npm, pnpm, Yarn classic, and Bun global installations from verified package roots and known global layout patterns.
- [x] 2.5 Warn but continue when PATH-resolved `oms` differs from the current executable, unless package-manager evidence conflicts.
- [x] 2.6 Classify project-local, temporary runner, development, and unknown contexts as non-mutating outcomes.
- [x] 2.7 Build guidance commands from project `packageManager`, lockfile, and dependency/devDependency evidence when available.
- [x] 2.8 Cover environment-manager-controlled prefixes when `bin/oms`, package root, and package-manager layout prove a persistent global install with a clear selected manager.

## 3. Update Command Behavior

- [x] 3.1 Add the `oms update` command with `--check` and `--yes` options.
- [x] 3.2 Print current version, latest version, detected context, and selected command when applicable.
- [x] 3.3 Make `--check` non-mutating even when combined with `--yes`, and show context only when an update is available.
- [x] 3.4 Prompt for explicit confirmation before running a confident global update unless `--yes` is provided.
- [x] 3.5 In non-interactive mode without `--yes`, print the selected command and rerun guidance without mutating.
- [x] 3.6 Run reinstall-style `@latest` global package-manager commands with inherited stdio, using `shell: false` on POSIX and shell execution on Windows for `.cmd`/`.bat` shims.
- [x] 3.7 Refuse automatic mutation for project, ephemeral, development, and unknown contexts while printing safe guidance.
- [x] 3.8 Keep update outcomes within existing `0`/`1`/`2` exit-code conventions and normalize package-manager failures to `1`.
- [x] 3.9 Run best-effort post-update `oms --version` verification and report mismatches as warnings without failing successful updates.

## 4. Tests and Documentation

- [x] 4.1 Add CLI tests for `--check` up-to-date, update-available, and registry failure behavior.
- [x] 4.2 Add detection tests for confident global contexts and non-mutating project, ephemeral, development, and unknown contexts.
- [x] 4.3 Add command behavior tests for confirmation, `--yes`, guidance-only contexts, and package-manager failures.
- [x] 4.4 Add guarded `OMS_TEST_MODE=1` test hooks for registry, path detection, package-manager execution, and post-update verification.
- [x] 4.5 Document `oms update`, `--check`, and `--yes` usage in the README.
- [x] 4.6 Add a concise `oms update --help` safety sentence explaining that only confident global installs are updated automatically.
- [x] 4.7 Run the full test suite with `npm test`.
