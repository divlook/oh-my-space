# Design

## Context

See `proposal.md` for motivation. This is a behavior-preserving refactor, so `.openspec.yaml` declares `skip_specs: true`. Existing `cli-self-update` requirements and `ai-submodule-workflow` guarded deterministic prompt requirements remain authoritative.

The package publishes `dist/oms.js`, not its source Modules. Production TypeScript checking excludes the test tree and JavaScript release/build scripts; language-server references alone therefore cannot prove an export unused. The audit cross-checked source references with repository text searches, including tests and tooling. Its strict unused-local/parameter type check passed: the findings are unnecessarily public declarations, not unused Implementation.

The read-only smoke run established that stable parsing accepts a nonempty invalid-semver `latest` string and ignores malformed `beta`, while channel parsing rejects both. It also established that select-default responses supplied to multi-select, confirm, and text prompts are rejected by `consume()` before their redundant guards. These observations are not a substitute for the implementation's baseline full-suite run.

## Goals / Non-Goals

**Goals:**

- Shrink the Interface without deleting behavior or splitting useful Modules merely because their Implementation is small.
- Keep the response-kind invariant local to the existing prompt seam, which already has real interactive and deterministic queue adapters.
- Give dist-tag structure extraction one maintenance location while keeping the two real parsing policies explicit.
- Use behavior contracts through caller-facing Interfaces, not tests asserting source text, export counts, forwarding, or file layout.

**Non-Goals:**

- No command, option, user configuration, dependency, network retry, telemetry, new adapter, or runtime-validation policy.
- No changes to Git operations, preparation, topology transactions, package-manager execution, or skill installation.
- No arbitrary deletion of tests, small Modules, generated files, archived records, or compatibility diagnostics.
- No shared registry-fetch abstraction: request timing, call count, errors, and transport code remain as they are.

## Decisions

### 1. Privatize the audited declarations, not their Implementation

Remove `export` from these 35 declarations, preserving their bodies and inferred types:

| File under `scripts/lib/` | Declarations |
| --- | --- |
| `alias-preparation.ts` | `AliasRegistration`, `PrepareResult`, `PrepareOptions`, `AttachVerdict`, `attachDetachedHead`, `BatchPreparation` |
| `branch-baseline.ts` | `BaselineResolution`, `BaselineReport` |
| `env.ts` | `useColor`, `readBuildCommit` |
| `git.ts` | `WorkspaceManifestResolution` |
| `gitmodules-reconcile.ts` | `ReconcileResult` |
| `install-context.ts` | `collectRuntimeEvidence` |
| `manifest.ts` | `emitLegacyRenameMessage` |
| `status.ts` | `headShortSha`, `ChangeCounts`, `PinValue`, `RecordVerdict`, `RootTopologyCheck`, `RootTopologySafety` |
| `tree-ops.ts` | `ManagedTreeState`, `treeRelPath`, `rootLocalExcludePath`, `ensureTreeExcluded` |
| `types.ts` | `InstallContextKind` |
| `skills.ts` | `skillFindings` |
| `prompts.ts` | `AliasSetResolution` |
| `prompt-adapter.ts` | `PROMPT_CANCEL`, `PromptQueueError` |
| `submodule-config.ts` | `AttachBranchResult`, `RemoteReconciliation` |
| `root-tx.ts` | `gitDir`, `hashFile`, `FinalizeInput`, `FinalizeResult` |

Recheck references immediately before mutation to accommodate intervening user changes. An export newly used by a real caller stays exported, and the exception is recorded; the number 35 is the audited baseline, not a permanent quota. Types may still appear in the inferred Interface of exported functions without requiring their own named exports.

Do not privatize test-used declarations such as `__resetPromptQueueForTests`, `analyzeManagedBlock`, or `installManagedBlock`. Preserve build/release exports such as `validatePublishedSkillMetadata`, `selectBetaBaseVersion`, and `PACKAGE_NAME`, whose callers are outside the production TypeScript project.

Alternative rejected: deleting functions or moving them into callers. It would remove needed behavior or reduce Locality instead of shrinking the Interface.

### 2. Type the existing prompt invariant once

Keep the external guarded-prompt Interface and response-queue format unchanged. Define an internal consumed-result mapping for each `PromptType`: select may return a value or a default marker; multiselect returns `string[]`; confirm returns `boolean`; text returns `string`. All kinds retain the native-fallback and cancellation alternatives.

Use concrete overloads on the existing private `consume()` function to expose those per-kind results. Its single Implementation continues validating entries and rejecting mismatches before returning. The broad internal Implementation return union remains private; no new runtime object, public method, or adapter is necessary.

Then remove only the unreachable `useDefault` checks in `guardedMultiselect`, `guardedConfirm`, and `guardedText`, and remove value casts made unnecessary by the overloads. Preserve select default handling, missing-initial-value rejection, cancellation, exhaustion, malformed queue behavior, leftover detection, reset support, and `OMS_TEST_MODE=1` gating.

Alternative rejected: removing guards and widening casts to silence the compiler. That hides the invariant rather than encoding it. A generic framework for arbitrary prompt kinds would add Interface and Implementation complexity without additional Leverage.

### 3. Consolidate parsing in the existing package-channels Module

Relocate `latestFromRegistryJson(data: unknown): string` from `update.ts` to `package-channels.ts`. Retain `registryDistTagsFromJson(data: unknown): RegistryDistTags` there. Each caller selects the existing small function matching its needs; do not expose validation flags or raw dist-tag objects.

Use one private dist-tag object extraction helper shared by the two functions. Its internal policy has only the two existing caller cases and preserves their current outer-object/missing-field error classification. Keep latest-only string validation and strict channel semver validation separate after that extraction. This is an internal seam, not a new interchangeable dependency seam.

Compatibility matrix:

| Input | Latest-only parsing | Strict channel parsing |
| --- | --- | --- |
| Non-object or array response | Existing JSON-object error | Existing JSON-object-with-dist-tags error |
| Object without `dist-tags` | Existing missing-latest error | Existing JSON-object-with-dist-tags error |
| Missing, null, array, or non-object `dist-tags` | Existing missing-latest error | Existing missing-latest error |
| Missing `latest` key | Existing missing-latest error | Existing missing-latest error |
| Present empty or non-string `latest` | Existing missing-latest error | Existing invalid-latest error |
| Nonempty invalid-semver `latest` | Return unchanged string; `compareVersions()` rejects it at the existing stage | Existing invalid-latest error |
| Valid `latest`, missing or null `beta` | Return latest | Return latest and null beta |
| Valid `latest`, malformed `beta` | Ignore beta and return latest | Existing invalid-beta error |
| Valid latest and beta versions | Return latest | Return both versions |

Preserve existing property-access semantics; do not introduce an own-property-only policy. Keep error categories and user-visible messages unchanged. `compareVersions()` stays in `update.ts`, including its invalid-registry-version error. Registry-fetch functions in `update.ts` and `skills.ts` remain unchanged except the stable parser import location.

Migrate every source and test import to the new location and remove the old declaration. No re-export or pass-through alias. Two exported parsing functions are justified by two observed policies; one strict parser for both callers would change stable-update behavior.

### 4. Verify behavior at the existing seam

Use existing unit and integration contracts after each coherent edit. Extend existing prompt contracts for select defaults presented to each non-select kind, valid typed responses, and cancellation. Extend parser contracts to preserve the matrix above, especially malformed beta not blocking stable-only parsing and invalid latest reaching the existing semver-comparison error. Register meaningful new contracts in `tests/test-inventory.json` only as required by the existing validator; do not test export counts or source structure.

Before editing, capture `npm test` and focused bundled-CLI output for `update --check` and `doctor` using existing deterministic fixtures/environment controls. After editing, build and exercise those same scenarios and a queued-prompt CLI journey. Use existing helpers to avoid public network calls or package-manager mutation. The final gate is `npm test`; focused commands alone do not constitute package verification.

## Risks / Trade-offs

- [Tests and JavaScript tooling are outside production language-server coverage] → Cross-check repository references and compile the test project before removing visibility.
- [Exported functions infer private named types] → Preserve their structures and verify actual caller/test compilation rather than forcing explicit casts or public aliases.
- [Type-only cleanup could weaken queue checks] → Keep runtime validation in `consume()` and exercise mismatch, cancellation, malformed, exhausted, and leftover behavior.
- [Shared parsing could silently strengthen validation] → Preserve the two policies, their error classification, and semver-validation timing with regressions and CLI smoke evidence.
- [Privatizing already tree-shaken exports may not shrink the bundle] → Claim only a smaller Interface and improved Locality, not an unmeasured performance or size gain.
- [Many export edits obscure behavioral changes] → Keep visibility cleanup, prompt typing, and parsing relocation as separate buildable steps.

## Migration Plan

No user data migration or deployment sequencing is needed. Apply visibility cleanup, prompt typing, and parser consolidation in separate coherent steps, updating callers and relevant tests atomically in each step. Preserve a successful build and passing affected tests after each step, then run the canonical suite and bundled-CLI smoke checks. Add an English maintenance changeset after verification. Command documentation remains intentionally unchanged.

If a step fails verification, repair or revert only that step's changes; do not restore obsolete forwarding exports or remove safety contracts as a workaround. Existing local workspace and installation state must remain untouched by verification fixtures.
