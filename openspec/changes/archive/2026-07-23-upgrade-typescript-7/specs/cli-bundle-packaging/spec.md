## ADDED Requirements

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
