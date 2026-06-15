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

### Requirement: Behavior parity verified by the test suite

The bundled `dist/oms.js` SHALL pass the existing black-box test suite unchanged, and interactive code paths not covered by the suite SHALL be verified by a manual smoke check.

#### Scenario: Full suite passes against the bundle

- **WHEN** `npm test` runs (which builds the bundle, then spawns `dist/oms.js`)
- **THEN** all tests pass with no modifications to `tests/cli.test.js`

#### Scenario: Interactive prompt path verified manually

- **WHEN** the bundled CLI is run in a real TTY in a way that triggers an interactive prompt (e.g. `oms sync` with no alias)
- **THEN** the `@clack/prompts` selection UI renders and accepts input correctly
