## Context

The `skills` CLI installs OMS skills from the GitHub repository source, so installation follows `main` independently of npm's `latest` and `beta` tags. The running CLI currently bakes only each skill's own `metadata.version`; it interprets a newer installed skill as evidence that OMS may be behind, even though freshness does not establish runtime incompatibility.

The current npm tags demonstrate the ordering problem: `latest` is `0.14.2`, while the beta containing post-`0.14.2` behavior was published as `0.14.2-beta.sha-6d0b8be`. SemVer correctly orders that prerelease below `0.14.2`, despite the beta source being newer. The next stable line is intentionally OMS `1.0.0`.

## Goals / Non-Goals

**Goals:**

- Give every skill one machine-readable OMS range and one standard human-readable compatibility declaration.
- Keep skill-content freshness independent from runtime compatibility.
- Make beta and stable versions comparable using ordinary SemVer range evaluation.
- Give an incompatible stable user an actionable `latest` or `beta` recovery path without changing diagnostic exit behavior.
- Prepare a Changesets major release intent for `1.0.0` without publishing as part of implementation.

**Non-Goals:**

- Pin skill installation to a Git commit or bundle skills inside the npm package.
- Make third-party Agent Skills clients enforce `compatibility`.
- Automatically publish, promote, retag, or remove an npm version.
- Add a general-purpose prerelease selector to `oms update`.
- Annotate individual paragraphs or commands inside a skill with separate version ranges.

## Decisions

### Use a skill version and an OMS range as separate contracts

Each skill will retain its own semantic content version and add an OMS range:

```yaml
compatibility: Requires oh-my-space >=1.0.0-0.
metadata:
  author: oh-my-space
  version: "1.1.0"
  oh-my-space-version: ">=1.0.0-0"
```

`metadata.version` answers whether installed instructions differ from the copy baked into the CLI. `metadata.oh-my-space-version` answers whether the running executable supports every instruction in the installed skill. The top-level `compatibility` field is the Agent Skills standard field exposed to humans and agents; build validation requires it to be exactly derived from the structured range so the duplicate text cannot drift.

The range is per skill. The implementation will audit all three current skill bodies. Skills that describe post-`0.14.2` behavior use `>=1.0.0-0`; a skill that is fully accurate for an earlier release retains its true earlier minimum. A wording-only skill change bumps the skill version but does not raise the OMS range.

`1.0.0-0` is used instead of `1.0.0` because it admits every `1.0.0` prerelease as well as the final stable release under node-semver. It also excludes `0.14.2`.

### Bake complete skill references

Replace the build metadata's version-only map with a record containing both fields:

```json
{
  "skills": {
    "oms-pointer": {
      "version": "1.1.0",
      "omsVersion": ">=1.0.0-0"
    }
  }
}
```

The build reads only `SKILL.md` frontmatter, validates quoted semver skill versions and valid semver ranges, and validates the standard compatibility sentence. The runtime treats absent build metadata as unavailable and remains silent, preserving the existing published-tarball/development fallback. This build-info shape is internal, so the version-only field is removed rather than retained as a compatibility alias.

Installed-skill parsing returns both values in one pass. Missing or malformed skill versions remain stale-skill findings. Missing or malformed OMS ranges become unverifiable-compatibility findings; they do not prove that the CLI must be updated.

### Model freshness and compatibility independently

For every located installed skill, classification produces two results:

```text
freshness:       older | current | newer | unverified
compatibility:   compatible | incompatible | unverified
```

Remediation follows the failed dimension:

| Freshness | Compatibility | Action |
| --- | --- | --- |
| older/unverified | any | Update or reinstall the skill |
| current/newer | compatible | No CLI update required |
| current/newer | incompatible | Resolve a compatible OMS channel |
| current/newer | unverified | Update or reinstall the skill |

A newer compatible skill may be reported as informational drift, but it never produces the current unconditional `oms update` recommendation. Exact-and-compatible installations remain silent.

### Resolve release channels only for incompatibility

Local classification remains synchronous and network-free. If at least one installed skill is incompatible, the reporting path performs one best-effort npm metadata lookup for `dist-tags.latest` and `dist-tags.beta`, then evaluates both versions against every incompatible range.

Remediation preference is deterministic:

1. Prefer `latest` when it satisfies the range.
2. Otherwise use `beta` when it satisfies the range.
3. Otherwise state that no published channel is known to satisfy the range.
4. If lookup fails, retain the local mismatch report and show explicit channel inspection/install guidance without claiming compatibility.

The registry lookup is shared by all findings in one command invocation and uses the existing registry timeout and package-manager detection conventions. Reporting remains informational. `oms doctor` may therefore become asynchronous, but a registry failure does not increment its warning count or change its exit status.

### Derive beta versions from the Changesets release plan

The beta publisher continues generating commit-identified versions, but it obtains the stable base from Changesets' machine-readable release plan. It selects the single `oh-my-space` release and reads its computed `newVersion`; for the current major Changeset that value is `1.0.0`, producing:

```text
1.0.0-beta.sha-<short-hash>
```

The publisher uses the Changesets release-plan API through an explicit development dependency rather than parsing human CLI output or asking the maintainer to repeat the version. It rejects a missing `oh-my-space` release, multiple matching releases, a non-stable computed version, or a version that is not greater than the repository package version before mutating package metadata. The `--base-version` option is removed: a conflicting manual override would recreate the ambiguity this design is intended to eliminate.

A major Changesets entry is therefore a prerequisite for beta publication and records the intended `1.0.0` stable release. Existing minor and patch entries are absorbed by that major release. Publishing the new beta and later running Changesets version/publish remain explicit maintainer actions, but choosing the version is deterministic.

The already-published `0.14.2-beta.sha-6d0b8be` is not mutated or unpublished. Publishing the first automatically derived `1.0.0-beta.sha-*` moves the `beta` dist-tag forward and makes compatibility ranges reliable.

### Keep compatibility at whole-skill granularity

A skill is treated as one coherent instruction contract. The design does not add conditional paragraphs such as “use this flag only on 1.0.” Whole-skill compatibility is conservative, easier for agents to follow, and testable from frontmatter alone. When a new CLI dependency is introduced, the skill version and its minimum OMS range move together.

## Risks / Trade-offs

- **GitHub `main` remains ahead of npm:** Metadata and diagnostics expose the mismatch but do not prevent an Agent Skills client from loading an incompatible skill before OMS runs. Commit-pinned or npm-bundled skill distribution remains a possible later hardening step.
- **Registry lookup adds latency:** It occurs only for a locally established incompatibility, uses one bounded request, and degrades to local guidance on failure.
- **Human and machine fields duplicate a range:** Exact build-time equality validation makes the structured metadata authoritative and prevents silent divergence.
- **Per-skill minimums require judgment:** The implementation audit must prove that every named command and behavior exists across the declared range; tests should cover the selected boundary versions or repository history evidence.
- **Prerelease ranges are easy to misuse:** Using `>=1.0.0-0` and publishing `1.0.0-beta.*` keeps node-semver behavior straightforward. Future beta releases must likewise use their intended stable target.
- **Existing beta cannot satisfy the new range by version:** It remains installable but is an anomalous historical artifact. Moving the `beta` tag to a correctly based 1.0 prerelease resolves the active channel without unpublishing history.
