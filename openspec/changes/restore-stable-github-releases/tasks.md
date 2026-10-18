# Tasks

## 1. Verified metadata-only finalization

- [x] 1.1 Add `scripts/finalize-stable-release.mjs` with the current stable package version as its default and explicit `--version`/`--commit` recovery inputs. Verify exact npm JSON metadata, published `gitHead`, main-history membership, historical package version, and historical changelog entry before any write; cover missing evidence, prerelease input, and identity mismatch with isolated integration fixtures.
- [x] 1.2 Implement create-only remote tag and published stable GitHub Release completion for `divlook/oh-my-space`, preserving matching tags/releases and refusing conflicts. Verify actual Git refs in disposable repositories and modeled GitHub state for missing metadata, annotated-tag identity, matching no-op, tag-only recovery, conflicting tag, and incompatible Release scenarios; register new coverage in `tests/test-inventory.json` following existing ownership conventions.
- [x] 1.3 Propagate failed finalization with the incomplete phase and an exact metadata-only recovery command, without npm mutation or deletion of completed metadata. Verify a tag-success/Release-failure case resumes to one complete release, and add the finalizer's authentication, inputs, and safety rules to `docs/release-channels.md`; each implementation increment must remain buildable with passing coverage.

## 2. Stable publication integration

- [x] 2.1 Extend `npm run release` to finalize only after successful `changeset publish`; disable the Action's built-in GitHub Release ownership and provide full checkout history. Verify the actual entry point in a disposable fixture succeeds with Changesets 3-style output and with an already-published version, does not finalize after publisher failure, and fails after GitHub finalization failure without relying on the Action's parsed `published` output.
- [x] 2.2 Update the stable maintainer sequence and completion checks in `docs/release-channels.md` and the development release reference as needed; add an English patch Changeset summary without running version preparation. Verify the documented metadata-only commands use the new entry point and explicit published commits, and that beta instructions and existing package gates remain unchanged.
- [x] 2.3 Run an end-to-end throwaway smoke through the real finalizer with disposable Git history, a local bare remote, and controlled network boundaries; observe correct tag commit, correct version-specific notes, repeat-run preservation, and nonzero partial-failure handling. Run `npm test` and `npm pack --dry-run --ignore-scripts` once after integration, retaining passing build and suite results without any public npm publish.

## 3. Recover published versions and verify remote completion

- [x] 3.1 Record current npm versions/dist-tags and inspect remote metadata immediately before recovery. Run metadata-only finalization for `2.0.0` at `b2a86e8876ac76ffc8e4daed8146f82fe93613d1`; verify `v2.0.0` resolves to that commit and its Release is published, non-prerelease, and contains the 2.0.0 changelog entry. Preserve matching state; stop and report conflicts or unavailable credentials rather than overwriting anything.
- [x] 3.2 Run metadata-only finalization for `2.0.1` at `58af8b34c6d2801ea9900e8ff4275d3c2e70c1d6`; verify its remote tag commit and published stable Release notes, then repeat both recovery commands to prove no duplicates or rewrites. Compare npm versions/dist-tags with the pre-recovery snapshot to prove no republication or channel changes, and report both Release URLs and verified commit IDs.
