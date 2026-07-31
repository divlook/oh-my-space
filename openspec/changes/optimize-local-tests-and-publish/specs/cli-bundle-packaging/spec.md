## MODIFIED Requirements

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

## ADDED Requirements

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
