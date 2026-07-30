## 1. Version the published skills

- [x] 1.1 Add a `metadata` block with `author: oh-my-space` and `version: "1.0.0"` to the frontmatter of `skills/oms-workspace/SKILL.md`, `skills/oms-pointer/SKILL.md`, and `skills/oms-branch/SKILL.md`, keeping `version` a quoted string.
- [x] 1.2 Extend the existing frontmatter test in `tests/cli-tools.test.js` to assert that each skill declares a non-empty `metadata.author` and a `metadata.version` that is valid semver and parses as a string, not a number.
- [x] 1.3 Assert in the same file that no skill body declares the skill's own version, so the marker stays in frontmatter while `schemaVersion` stays in the body.

## 2. Guard the bump

- [x] 2.1 Add a helper in `tests/cli-tools.test.js` that hashes a skill's `name`, `description`, and body while excluding the frontmatter `metadata` block, so bumping the version does not perturb its own hash.
- [x] 2.2 Add a per-skill `(version, contentHash)` snapshot constant and a test that fails with an actionable message naming the skill and its current version when the hashed content no longer matches.
- [x] 2.3 Record the bump policy — `major` for guardrail-kernel or scope-contract changes, `minor` for instruction or `description` changes, `patch` for wording — next to the snapshot constant so the failure message has somewhere to point.

## 3. Bake the reference into the build

- [x] 3.1 In `scripts/build.mjs`, read `metadata.version` from each published `SKILL.md` and write the resulting name-to-version map into `dist/build-info.json` alongside the existing `commit` key, tolerating a missing `skills/` directory the way the git lookup already tolerates a missing repository.
- [x] 3.2 Add a reader in `scripts/lib/env.ts` that returns the baked skill versions, or an empty result when the key is absent, mirroring `readBuildCommit`.
- [x] 3.3 Add a test override so the baked versions can be supplied per test through the existing `OMS_TEST_MODE` gate, following `OMS_NPX_BIN`.

## 4. Discover installed skills

- [x] 4.1 In `scripts/lib/skills.ts`, read the global lock (`~/.agents/.skill-lock.json`, honouring `XDG_STATE_HOME`) and the project locks (workspace root, plus the current directory when it differs), tolerating a missing, unparseable, or unrecognised file by returning no entries rather than throwing.
- [x] 4.2 Keep only lock entries whose recorded source is the `oms` repository, so a same-named third-party skill is excluded when provenance is available.
- [x] 4.3 Locate installed `SKILL.md` files by globbing one level of dot-directory under the home directory and under the workspace root, covering both the tool's canonical directory and direct agent-directory installs.
- [x] 4.4 Add a test override for the home search root and the lock paths, so tests never mutate `HOME` — moving `HOME` would also move where `git` looks for global configuration in the same subprocess and break existing fixtures.

## 5. Classify drift

- [x] 5.1 Add a classifier that, per skill, resolves the installed version from the located file's `metadata.version` and compares it against the baked reference with `semver.compare`.
- [x] 5.2 Classify a missing or non-semver installed version as older than any reference, so copies predating version tracking are reported rather than skipped.
- [x] 5.3 Classify a lock entry with no locatable file as installed-but-unverified, distinct from both drift and absence.
- [x] 5.4 Return no findings when the baked reference is unavailable, when nothing is installed, or when every installed version matches.
- [x] 5.5 Report each drifted skill with the scope it was found in, and where a skill is found in more than one scope report only the scopes that are drifted.

## 6. Report in doctor

- [x] 6.1 Call the classifier from `runDoctor` and emit one `log.info` line per drifted skill naming the skill, the installed version, the current version, and the scope.
- [x] 6.2 Emit a single remediation line covering every skill that is older than the reference, passing the affected names to `npx skills update` without a scope flag.
- [x] 6.3 Emit a separate group for skills newer than the reference, naming `oms update` as the remediation.
- [x] 6.4 Leave the `warnings` counter and the return value untouched, so a workspace whose only finding is skill drift still exits zero.
- [x] 6.5 Add tests covering older, newer, missing-version, installed-but-unverified, all-matching, not-installed, partially installed, and absent-reference cases, asserting the exit code stays zero throughout.

## 7. Report during self-update

- [x] 7.1 In `runUpdate`, report drift on the path where the installed version already matches the registry latest, before the existing up-to-date success message.
- [x] 7.2 After a successful upgrade, report that skills are installed and point at `oms doctor`, without comparing versions and without spawning the newly installed binary.
- [x] 7.3 Leave update's exit codes unchanged, and emit nothing about skills when none are installed.
- [x] 7.4 Add tests for the up-to-date path, the post-upgrade path, and the no-skills-installed path.

## 8. Document and release

- [x] 8.1 Extend the README "Workspace skills" section with what the skill version means, the bump policy, and how `oms doctor` surfaces drift alongside the `npx skills update` command that resolves it.
- [x] 8.2 Confirm the `oms doctor` row in the README command table still reads correctly — the exit-code contract is unchanged because the new reporting is informational.
- [x] 8.3 Add a `minor` changeset describing the skill version marker and the new drift reporting.
- [x] 8.4 Run `npm test` and confirm the build, the type check, and the full suite are green.
