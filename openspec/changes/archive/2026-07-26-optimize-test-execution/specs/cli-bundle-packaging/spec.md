## MODIFIED Requirements

### Requirement: Behavior parity verified by the test suite

The bundled `dist/oms.js` SHALL pass the complete black-box behavior suite, and the suite MAY be reorganized into independent files and executed with bounded parallelism provided its behavioral inventory and isolation are preserved. Interactive code paths not covered by the suite SHALL be verified by a manual smoke check.

#### Scenario: Full suite passes against the bundle

- **WHEN** `npm test` runs and builds the bundle before executing the black-box test files
- **THEN** all tests pass against `dist/oms.js`
- **AND** reorganizing or parallelizing the files does not remove baseline behavioral cases

#### Scenario: Interactive prompt path verified manually

- **WHEN** the bundled CLI is run in a real TTY in a way that triggers an interactive prompt (e.g. `oms sync` with no alias)
- **THEN** the `@clack/prompts` selection UI renders and accepts input correctly
