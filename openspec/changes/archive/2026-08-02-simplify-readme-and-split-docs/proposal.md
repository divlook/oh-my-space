## Why

The README currently mixes first-time onboarding with detailed command, workspace, AI tooling, migration, and contributor reference material, making the product harder to understand and the document harder to scan. The user-facing documentation also relies on implementation-specific Git terminology that can be replaced or explained in plain language without losing important safety guarantees.

## What Changes

- Turn `README.md` into a short product landing page focused on what OMS does, who it helps, installation, a minimal quick start, documentation links, and the license.
- Move detailed setup, workspace behavior, command guidance, configuration, AI coding tool integration, contributor instructions, and migration navigation into focused documents under `docs/`.
- Rewrite retained and moved content in concise, task-oriented English that leads with user outcomes, explains unavoidable Git terms when first used, and uses consistent names for core concepts such as the commit recorded by the main project.
- Separate normal workflows from advanced behavior and recovery details so readers can act without first learning OMS internals.
- Treat built-in command help as the source for exact arguments, options, and exit codes while the documentation explains command choice, repository boundaries, workflows, and safety behavior.
- Update internal documentation links affected by moved sections, including migration-guide links, while keeping detailed reference material discoverable from the README.
- Make no CLI behavior, configuration format, or runtime dependency changes.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `readme-onboarding`: Narrow the README to introductory onboarding, provide navigation to focused documentation, and require accessible, consistent language across the linked user documentation.

## Impact

- Affects `README.md`, new or reorganized files under `docs/`, and links from existing migration documentation.
- May affect documentation-link strategy for the npm-rendered README because the published package currently includes `README.md` but not `docs/`.
- Does not affect CLI commands, public APIs, `oms.yaml`, package dependencies, or runtime behavior.
