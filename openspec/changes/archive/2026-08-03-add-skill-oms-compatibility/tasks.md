## 1. Skill Compatibility Metadata

- [x] 1.1 Add shared parsing and validation for a skill's quoted `metadata.version`, quoted `metadata.oh-my-space-version` semver range, and exactly matching standard `compatibility` sentence; cover valid, missing, malformed, and inconsistent frontmatter while keeping the focused unit suite green.
- [x] 1.2 Replace the version-only build-info map with complete skill references containing `version` and `omsVersion`, update runtime environment readers and types in the same step, and verify build-info generation plus the no-reference fallback.
- [x] 1.3 Audit every current skill instruction against released command behavior, assign the earliest accurate OMS range (`>=1.0.0-0` where post-`0.14.2` behavior is required), update the human compatibility field and any stale v1 instructions, bump only affected skill content versions, and keep skill drift and guardrail tests green.

## 2. Independent Diagnostics

- [x] 2.1 Refactor installed-skill parsing and findings to classify freshness and runtime compatibility independently, including unverifiable metadata, with unit coverage for every classification pair and prerelease range boundary.
- [x] 2.2 Update local `oms doctor` and up-to-date `oms update` reporting so older skills still receive `npx skills update`, newer compatible skills never cause a false CLI update recommendation, exact compatible skills remain silent, and all findings remain informational.
- [x] 2.3 Add one bounded, best-effort npm dist-tag lookup only when incompatible skills exist; prefer a satisfying `latest`, otherwise a satisfying `beta`, and cover stable, beta, no-match, malformed-response, timeout, and package-manager-specific remediation without changing exit status.
- [x] 2.4 Convert affected reporting call sites to the required asynchronous flow, preserve post-upgrade deferral to `oms doctor`, and run the focused doctor, update, and skills CLI scenarios.

## 3. OMS 1.0 Beta Line

- [x] 3.1 Add a Changesets major release entry recording the OMS 1.0 compatibility and beta-base contract without running versioning, publishing, or changing npm dist-tags.
- [x] 3.2 Add the Changesets release-plan API as an explicit development dependency and change the beta publisher to derive the single `oh-my-space` `newVersion`, remove manual base-version input, reject missing, ambiguous, non-stable, or non-forward plans before mutation, and cover restoration, dry-run, and verification-reuse behavior.
- [x] 3.3 Update beta publisher help and release-channel documentation to show argument-free target selection, explain the historical `0.14.2-beta` anomaly, and document moving `beta` forward with an automatically derived `1.0.0-beta.sha-*` publish rather than unpublishing history.

## 4. Documentation and Verification

- [x] 4.1 Update AI coding tool and command documentation to distinguish skill freshness from OMS runtime compatibility, document the new frontmatter contract, and show the stable-first then beta remediation behavior.
- [x] 4.2 Run the repository's build and complete canonical test command, then perform a CLI smoke scenario with mocked `latest=0.14.2`, `beta=1.0.0-beta.sha-test`, and an installed skill requiring `>=1.0.0-0` to confirm that `oms doctor` recommends beta and preserves its informational exit status.
- [x] 4.3 Run OpenSpec validation for `add-skill-oms-compatibility` and reconcile the implementation, tests, and records with every scenario before requesting the explicit maintainer beta publish.
