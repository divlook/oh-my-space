## Purpose

Define how the `oms` CLI is built and packaged as a single self-contained bundle, ensuring no runtime dependencies, preserved runtime path resolution, a type-checking gate, and verified behavior parity.

## Requirements

### Requirement: Single self-contained bundle artifact

The build SHALL produce the `oms` CLI as a single self-contained ESM file at `dist/oms.js` with no runtime `node_modules` dependencies. The runtime dependencies (`commander`, `@clack/prompts`, `semver`, `yaml`) SHALL be inlined into the bundle.

#### Scenario: Published package has no runtime dependencies

- **WHEN** the package is built and inspected
- **THEN** `package.json` declares no `dependencies` (the four former runtime deps live under `devDependencies`)
- **AND** `dist/oms.js` runs correctly without any third-party packages present in `node_modules`

#### Scenario: Bundle is an executable ESM file

- **WHEN** the build completes
- **THEN** `dist/oms.js` is ESM, begins with the `#!/usr/bin/env node` shebang on line 1, and carries the executable bit
- **AND** the `oms` bin entry resolves to `dist/oms.js`

### Requirement: Runtime path-resolution contract preserved

The bundled CLI SHALL preserve the existing runtime path resolution that relies on `import.meta.url`. `dist/oms.js` SHALL remain at the same relative location so that resolving one directory up yields the package root.

#### Scenario: Version and build metadata resolve

- **WHEN** the bundled CLI runs `oms --version`
- **THEN** it reads the version from the package-root `package.json` (not a fallback)
- **AND** `dist/build-info.json` is generated as a sibling file and read at runtime for the build commit

#### Scenario: CJS dependency interop works

- **WHEN** the bundled CLI executes any command that uses an inlined CommonJS dependency (e.g. `commander`)
- **THEN** it runs without a "Dynamic require ... is not supported" error
- **AND** a `createRequire` shim is present in the bundle to back internal `require()` calls

### Requirement: Type checking gate retained

The build SHALL run a TypeScript type check (`tsc --noEmit`) before bundling, since esbuild does not type-check.

#### Scenario: Type error fails the build

- **WHEN** a type error exists in any source module under `scripts/`
- **THEN** `npm run build` fails at the type-check step before producing a bundle

### Requirement: Dependency upgrades preserve the type-check gate

The system SHALL preserve the `tsc --noEmit` type-check gate behavior when the `typescript` devDependency is upgraded, including across a major-version upgrade.

The baseline for preservation SHALL be the behavior covered by the existing "Type checking gate retained" requirement and a clean pre-upgrade `npm test` run (build plus the black-box suite).

#### Scenario: Gate still runs before bundling after the upgrade

- **WHEN** `npm run build` runs after the `typescript` devDependency is upgraded
- **THEN** `tsc --noEmit` runs as the type-check gate before esbuild bundles
- **AND** a type error in any `scripts/` module still fails the build before a bundle is produced

#### Scenario: Type check stays green against the existing configuration

- **WHEN** the upgraded `typescript` runs the `tsc --noEmit` gate against the existing `tsconfig.json`
- **THEN** the type check completes with 0 errors across all `scripts/**/*.ts`

#### Scenario: Published bundle is unaffected by the upgrade

- **WHEN** esbuild produces `dist/oms.js` after the upgrade
- **THEN** the bundle output is determined solely by esbuild's emit and is unaffected by the `typescript` version, since TypeScript is used only for type-checking

### Requirement: Behavior parity verified by the test suite

The bundled `dist/oms.js` SHALL pass the complete layered behavior suite. The suite MAY verify pure decisions and injected orchestration below the process boundary, but SHALL retain bounded bundled-CLI coverage for every public command, representative end-to-end journeys, and data-integrity behavior where the real process or Git boundary is material.

#### Scenario: Full suite passes against the implementation and bundle

- **WHEN** `npm test` runs
- **THEN** unit and shallow integration layers verify internal behavior contracts
- **AND** the black-box layer verifies the bounded contracts assigned to `dist/oms.js`
- **AND** all baseline observable behavior contracts remain mapped to passing tests

#### Scenario: Interactive prompt path is verified manually

- **WHEN** the bundled CLI is run in a real TTY in a way that triggers an interactive prompt, such as `oms sync` with no alias
- **THEN** the `@clack/prompts` selection UI renders and accepts input correctly

### Requirement: Reused verification rebuilds the bundle

A package lifecycle that reuses a successful test record SHALL still execute the TypeScript gate and produce a fresh self-contained `dist/oms.js` bundle from the current package state.

#### Scenario: Matching test record and stale output

- **WHEN** prepack finds an exact verification record but `dist` is missing or stale
- **THEN** the package lifecycle rebuilds the bundle before package creation
- **AND** stale generated output is not trusted as verification evidence

### Requirement: Packaged bundle version parity

Before an npm package artifact is created or published, the lifecycle SHALL execute the freshly built CLI and verify that its reported version matches the package metadata version.

#### Scenario: Fresh artifact is internally consistent

- **WHEN** the production build succeeds during prepack
- **THEN** the bundled CLI executes successfully
- **AND** its version equals the package version selected for the artifact

#### Scenario: Artifact parity fails

- **WHEN** the built CLI cannot execute or reports a different version
- **THEN** package creation or publication stops
- **AND** any matching local verification record is invalidated
