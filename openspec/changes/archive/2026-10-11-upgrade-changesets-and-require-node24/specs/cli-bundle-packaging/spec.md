## ADDED Requirements

### Requirement: Published Node runtime support

The published package SHALL declare the Node engine range `^24 || >=26`. Node 24 SHALL be the minimum supported runtime line; Node 20, Node 22, and Node 25 SHALL be outside the supported range. Documentation SHALL distinguish permitted newer runtimes from the required Node 24 verification baseline.

#### Scenario: Supported baseline is installed
- **WHEN** a package manager evaluates the published Node engine range on Node 24
- **THEN** that runtime satisfies the declared requirement

#### Scenario: Removed runtime is evaluated
- **WHEN** the published Node engine range is evaluated on Node 20, Node 22, or Node 25
- **THEN** that runtime does not satisfy the declared requirement
- **AND** no custom startup rejection is required beyond the package manager's normal engine policy

#### Scenario: A newer runtime is permitted
- **WHEN** the published Node engine range is evaluated on a stable Node version of 26 or later
- **THEN** that runtime satisfies the declared requirement
- **AND** the documentation does not claim that every permitted future version has been verified

### Requirement: Node 24 package execution baseline

Development and release preparation SHALL use Node 24. The production bundle SHALL execute on Node 24 without runtime third-party dependencies and SHALL report the version selected in package metadata.

#### Scenario: Package is prepared on the baseline runtime
- **WHEN** maintainers build and inspect an OMS package on the configured Node 24 runtime
- **THEN** the bundled CLI executes without runtime third-party dependencies
- **AND** its reported version equals the package metadata version

#### Scenario: A user upgrades from a removed runtime
- **WHEN** a user reads the release intent or current installation requirements for the runtime-support change
- **THEN** the documentation identifies Node 24 as the minimum supported line and explains that the user's Node runtime must be upgraded
- **AND** the runtime-support removal is recorded as a major release intent
