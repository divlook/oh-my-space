---
"oh-my-space": minor
---

Add `oms branch clean [alias] [--base <ref>]` for confirmed cleanup of merged local branches in one source repository. Use the repository-specific local comparison base or an explicit cached remote-tracking branch without refreshing refs or bypassing protected baselines. Exclude protected and occupied branches, revalidate each confirmed tip, and delete with expected-commit transactions. Report partial results, configuration-cleanup failures, and shell-safe recovery commands while preserving remote refs and recorded commits. Document retained preparation effects, shallow-history limits, and unsupported external concurrent mutation.

Resolve the cached origin default by its full ref so local branches such as `origin/release` do not prevent cleanup from using the `release` baseline.
