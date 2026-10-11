# Tasks

## 1. Preservation baseline

- [x] 1.1 Capture the pre-edit `npm test` result and deterministic bundled-CLI observations for `update --check`, `doctor`, and a queued-prompt journey using existing disposable fixtures and test environment controls; verify exit codes, output, and unchanged fixture state without public network access or real package-manager mutation. The audit's smoke results do not count as this full-suite baseline.

## 2. File-local visibility

- [x] 2.1 Recheck language-server references and repository references, including tests and JavaScript tooling, for every declaration in design decision 1; remove only the unnecessary exports while preserving Implementation and inferred types. Verify `npm run build`, `npm run test:unit`, and `npm run test:integration` pass, and record any newly required export rather than deleting its caller or adding a shim.
- [x] 2.2 Add an English patch changeset describing the verified Interface reduction without claiming a measured bundle-size or runtime improvement; verify its package name and format follow `.changeset/config.json` and existing changeset conventions. Keep command documentation intentionally unchanged because no command behavior changes.

## 3. Prompt-kind invariant

- [x] 3.1 Add concrete private `consume()` overloads and per-kind consumed-result types in `prompt-adapter.ts`, then remove the three unreachable `useDefault` checks and casts made unnecessary by those types. In the same step, extend `tests/unit/prompt-adapter.test.ts` with behavior regressions for select-default mismatches in multiselect/confirm/text, correctly typed values, cancellation, and select-default handling; retain malformed/exhausted/leftover rejection and test-mode gating. Update test inventory registration if required. Verify `npm run build`, `npm run test:unit`, and `npm run test:integration` pass without opening real prompts for queued responses.
- [x] 3.2 Exercise a bundled CLI prompt journey with valid, cancelled, and mismatched queued responses in a disposable workspace; verify the baseline output/exit-code/state outcomes and no real-prompt fallback, then extend the maintenance changeset to mention the behavior-preserving prompt simplification.

## 4. Dist-tag parsing locality

- [x] 4.1 Move `latestFromRegistryJson()` into `package-channels.ts`, share private object extraction with `registryDistTagsFromJson()`, and preserve both policies and error classifications from design decision 3. Atomically migrate all source/test callers and delete the old declaration from `update.ts` without a forwarding export. Extend `tests/unit/update-install-agent-skill.test.ts` with the meaningful parser error/precedence cases, including invalid beta ignored for stable-only lookup, invalid beta rejected for channel lookup, missing/null beta accepted, and invalid latest rejected at the existing comparison stage; update inventory registration if required. Verify `npm run build` and `npm run test:unit` pass.
- [x] 4.2 Run deterministic bundled `update --check` and `doctor` scenarios covering valid latest, malformed latest, malformed beta, and missing beta using the existing `tests/cli-tools.test.js` environment conventions; verify outputs, errors, exit codes, and absence of package-manager mutation match the baseline. Run `npm run test:tools` and extend the maintenance changeset to describe parser consolidation without claiming stricter validation or new behavior.

## 5. Integrated verification

- [x] 5.1 Run the canonical `npm test` gate after all changes; verify its inventory, production build, unit, integration, and black-box layers pass and retain protected process-integrity/recovery coverage. Compare the final bundled-CLI smoke observations with task 1.1 and report any retained exports justified by intervening caller changes. Confirm existing command documentation and main specs remain intentionally unchanged, with no obsolete parser re-export or new dependency.
