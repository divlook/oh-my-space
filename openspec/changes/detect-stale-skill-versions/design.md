## Context

The `oms` workspace skills (`oms-workspace`, `oms-pointer`, `oms-branch`) are published as `skills/<name>/SKILL.md` and installed by the external Vercel Labs `skills` tool (`npx skills add divlook/oh-my-space/skills`). The CLI itself ships to npm as a single self-contained `dist/oms.js`; `skills/` is not part of the npm package (`files` lists only `dist/`, `README.md`, `LICENSE`).

That makes two independent distribution channels:

```
npm registry ──▶ oms CLI            GitHub main ──▶ skills/*/SKILL.md
```

Neither side carries a version today. The frontmatter holds only `name` and `description`. Consequently the CLI cannot tell whether the installed skills match what it was built against, and a mismatch can leave an agent following superseded guardrails.

The following facts were established empirically against `skills@1.5.21` by installing the real skills into sandbox `HOME` directories, not by reading the tool's source alone. They drive most decisions below.

**Install layout varies by invocation.** There is no single reliable location:

| Invocation | Installed `SKILL.md` location |
| --- | --- |
| `add -g -a claude-code -y` | `~/.claude/skills/<name>/SKILL.md` (real directory; `~/.agents/skills/` never created) |
| `add -g -y` | `~/.agents/skills/<name>/SKILL.md` |
| `add -y` (project) | `<cwd>/.agents/skills/<name>/SKILL.md` |

The tool's "canonical" directory (`.agents/skills/`) is populated only on some paths; the explicit-agent non-interactive path copies straight into the agent directory. All three layouts do match one shallow glob: `.*/skills/<name>/SKILL.md`, relative to `$HOME` or the project root.

**Lock files are written on every path, and carry provenance.** Two files, two formats:

| | Global | Project |
| --- | --- | --- |
| Path | `~/.agents/.skill-lock.json` (or `$XDG_STATE_HOME/skills/.skill-lock.json`) | `<cwd>/skills-lock.json` |
| Format `version` | `3` | `1` |
| Hash field | `skillFolderHash` (40 hex) | `computedHash` (64 hex) |
| Hash kind | git tree hash — reproducible with `git rev-parse HEAD:skills/<name>` (verified byte-for-byte) | sha256 from the tool's own folder-hash routine — not reproducible without reimplementing it |
| `source` | `divlook/oh-my-space` | `divlook/oh-my-space` |
| `skillPath` | `skills/<name>/SKILL.md` — the path **in the source repo**, not the install location | same |

So the lock proves installation and origin but never says where the file landed; the glob finds the file but cannot prove origin. The two are complementary, not redundant.

**Frontmatter survives installation.** `copyDirectory` copies `SKILL.md` verbatim for every agent except `eve`; the `eve` path filters `metadata` down to entries whose value is a string. Arbitrary keys therefore survive, and a marker must be a **string** to survive `eve`.

**`npx skills update <name...>` is already non-interactive and scope-agnostic.** When skill names are passed, scope resolution returns `both` without prompting, and multiple names are accepted in one invocation. No `-g`/`-p` needs to be suggested.

Constraints from the existing codebase:

- `oms status --json` must emit exactly one JSON object on stdout, and `@clack/prompts` `log.*` writes to stdout.
- `README.md` documents `oms doctor` as "Returns exit 2 if any warning is raised."
- `.github/workflows/release.yml` checks out at the `actions/checkout` default `fetch-depth: 1`, so git history is unavailable at release build time.
- The repo has an established test-override idiom gated by `OMS_TEST_MODE` (`OMS_NPX_BIN`, `OMS_TEST_PLATFORM`, `OMS_TEST_REGISTRY_RESPONSE`), and `ai-workspace-skill` already specifies that overrides of this kind exist for testability.

## Goals / Non-Goals

**Goals:**

- Give each published skill a version that a human can read and the CLI can compare.
- Detect drift in both directions and name the correct remedy for each.
- Report only when skills are actually installed; stay silent otherwise, because the skills are opt-in.
- Leave every existing exit-code contract intact.
- Keep the number of hand-maintained copies of the version at one.

**Non-Goals:**

- A global startup hook that checks on every `oms` invocation. Rejected: it would require guarding `oms status --json` stdout purity, a throttle state file, a suppression flag, and per-invocation file reads, in exchange for reaching users who never run `doctor`.
- Version display or a `--check` mode on `oms skills`.
- Detecting installs made with an explicit `--copy` into a non-glob-matching layout.
- Using the lock files' hashes (see Decisions).
- Fixing the pre-existing situation where a project-scope install leaves `.agents/` and `skills-lock.json` untracked in the workspace root repository.

## Decisions

### The marker is `metadata.version`, a string semver, per skill

Stored in frontmatter, alongside `metadata.author` for provenance:

```yaml
metadata:
  author: oh-my-space
  version: "1.0.0"
```

**Frontmatter rather than the body.** The existing spec requires `schemaVersion` to live in the body "not its frontmatter", because that value is an *instruction to the agent*. This marker's consumer is `oms doctor`, so it belongs where a machine reads it. Precedent exists in-repo: the OpenSpec skills under `.claude/skills/` carry `metadata: {author, version, generatedBy}`, and 22 of 40 surveyed installed skills use a `metadata` block.

**A string, not an integer.** The `eve` install path preserves only string-valued `metadata` entries. An integer revision would be silently dropped there.

**Per skill, not one shared revision.** Changing one skill then requires editing one file. A shared revision would require editing all three on every change, tripling the chance of a missed bump, and buys nothing: history shows 4 changes to `skills/` in total, 3 of them confined to `oms-branch`.

**semver over a bare counter.** `semver` is already bundled, so `semver.compare` is free. The components are policy-bearing rather than decorative: `major` for guardrail-kernel or scope-contract changes, `minor` for instruction or `description` changes, `patch` for wording. `description` counts as content because it determines when the skill fires. All three skills start at `1.0.0`; backfilling the real history would be archaeology, and pre-marker installs are treated as stale regardless.

`metadata.generatedBy` is not adopted — stamping the `oms` version would either churn on every release or duplicate the work the skill version already does.

### The reference value is derived at build time

`scripts/build.mjs` reads `metadata.version` from each `skills/*/SKILL.md` and writes it beside the existing commit metadata in `dist/build-info.json`, which `dist/` already ships. `readBuildCommit` establishes the pattern, including tolerating a missing value.

The alternative — a hand-written map in `constants.ts` pinned by a test, matching the existing `SKILL_KERNEL` idiom — was rejected because it makes three values to update per skill edit (`SKILL.md`, `constants.ts`, the snapshot) instead of two.

When the baked reference is absent (a build from a published tarball, where `skills/` does not exist), the check is skipped silently. This degradation path is mandatory, not optional.

### The lock files and a glob are used together

```
detect  ──▶  lock entries whose `source` is divlook/oh-my-space
             ~/.agents/.skill-lock.json  |  $XDG_STATE_HOME/skills/.skill-lock.json
             <repoRoot>/skills-lock.json  (and cwd, when it differs)

locate  ──▶  ~/.*/skills/<name>/SKILL.md
             <repoRoot>/.*/skills/<name>/SKILL.md
```

Either signal is sufficient to proceed; both absent means silence. The four states:

| Lock | File | Behaviour |
| --- | --- | --- |
| yes | yes | verify `source`, then compare versions |
| yes | no | report installed-but-not-located, with the refresh command |
| no | yes | proceed on name match; version compared, provenance unverified |
| no | no | silent — the skills are opt-in |

**Why not the canonical directory alone.** An earlier draft of this design assumed the tool always populates `.agents/skills/`; the sandbox installs above disprove it. `add -g -a claude-code -y` leaves that directory nonexistent.

**Why not the lock alone.** The lock does not record the install path, so it cannot supply a version. It is also the tool's private format: `readSkillLock` discards any lock whose `version` is below its own `CURRENT_VERSION`, which now stands at `3`. Gating on the lock would make the feature die silently at format `4`. Reading it tolerantly and falling back to the glob keeps the feature alive.

**Why not the glob alone.** It cannot establish origin, and it cannot distinguish "not installed" from "installed into a layout we do not match".

**Provenance is now safe to check**, unlike in the frontmatter, because `source` is present in installs that predate this change. Where only the glob finds a skill, provenance is simply unavailable and a name match is accepted.

**Glob depth is one level of dot-directory.** Some agents use non-dot or nested layouts (`data/skills`, absolute `globalSkillsDir`); those installs fall into the installed-but-not-located state rather than being scanned for.

### The lock files' hashes are not used

`skillFolderHash` in the global lock is exactly `git rev-parse HEAD:skills/<name>`, verified against the live repository. Using it would eliminate bump discipline entirely and would work for installs made today. It was still rejected on three counts:

1. A hash cannot distinguish older from newer, and direction determines which remedy to name.
2. The project lock stores `computedHash`, the tool's own sha256, which cannot be reproduced without reimplementing its algorithm — the check would be asymmetric across scopes.
3. Direction could be recovered by baking the list of historical tree hashes, but `release.yml` checks out shallow, so git history is unavailable at release build time.

### Reporting is `log.info`, and never changes an exit code

`doctor.ts` already reports actionable drift at info level without incrementing `warnings`: a moved submodule pointer. A stale skill is the same kind of finding.

Warning level was rejected for two reasons. Bumping `warnings` would make `oms doctor` exit 2 because of `~/.agents/` — state outside the workspace entirely — so a repository's CI could fail on a developer's personal skill directory. Everything `doctor` currently counts as a warning is a condition that breaks `oms` itself; a stale skill degrades the advice an agent receives, which is a different axis. And warning level without incrementing the counter would contradict the README's "Returns exit 2 if any warning is raised", forcing a caveat into a documented contract. Info level keeps that sentence true, so `README.md` needs no change there.

### Two report sites, each honest about what it can know

`oms doctor` always checks. `oms update` checks on the path where the installed CLI is already current — there its baked reference *is* the current reference, so the comparison is exact, and "oms is current but your skills are not" is the most useful thing it can say.

On the path where `oms update` has just upgraded the CLI, the running process is still the old binary and cannot know the new reference values. Rather than guess, it reports that skills are installed and points at `oms doctor`, which the new binary answers exactly. A handshake — spawning the freshly installed binary for its reference values — was rejected because it would add a CLI surface existing only to serve that handshake.

Diagnosis is one line per drifted skill; the remedy is one line total, since `npx skills update` accepts several names at once. Skills that are newer than the CLI's reference are grouped separately, because their remedy is `oms update`.

### Bump discipline is guarded by a snapshot test

`tests/cli-tools.test.js` gains a per-skill `(version, contentHash)` snapshot. The hash covers everything except `metadata` — `name`, `description`, and the body — so a `description` change forces a bump while bumping the version does not perturb its own hash.

A CI check diffing `skills/` against `main` was rejected: it needs `fetch-depth: 0` and a new workflow step, does not fire locally, and the workflow is deliberately minimal (a recently archived change optimised test execution).

This cannot be fully automated. Whether a content change deserves a bump, and which component moves, is a judgement. The snapshot's job is to make that judgement a deliberate act that shows up in a diff.

### Test overrides supply the search roots

The global search root and the lock paths are injected through `OMS_TEST_MODE`-gated overrides, following `OMS_NPX_BIN`. Overriding `HOME` directly was rejected: the test harness runs `git` in the same subprocess environment, and moving `HOME` moves where git looks for global configuration, which would break fixtures.

## Risks / Trade-offs

- **A missed version bump makes the feature silently inert.** → The snapshot test fails on any content change, so a bump must be considered. A contributor could still refresh the hash without moving the version; that shows up in the diff for review. No purely automatic guard is possible.
- **Between merge and release, a fresh install is newer than the released CLI.** → Direction detection reports it as "your oms may be behind" with `oms update`, rather than sending the user to a no-op `npx skills update`. It stays reported until the next release.
- **Non-matching install layouts cannot be version-checked.** → The lock still detects them, and they are reported as installed-but-not-located with the refresh command, rather than passing silently.
- **The lock formats are external and have already churned to `version: 3`.** → They are read tolerantly and only for detection and provenance; any parse failure or unexpected shape degrades to the glob path. A format change costs provenance, not the feature.
- **A same-named third-party skill could be compared against our reference.** → Where a lock entry exists, `source` excludes it. Where only the glob finds it, a name match is accepted and a wrong report is possible; the probability is negligible and the report is informational.
- **Info level is easier to miss than a warning.** → Accepted, in exchange for leaving the exit-code contract and workspace CI intact.

## Migration Plan

1. Land the marker, the build-time derivation, the check, and the tests together. Before release, `skills/` on the default branch carries versions while no released CLI checks for them, so nothing is reported.
2. On release, updated CLIs begin reporting. Every pre-existing install lacks `metadata.version` and is classified as stale, which is accurate: those copies predate version tracking, and `npx skills update` fetches the versioned skills from the default branch. There is no ordering hazard in either direction.
3. Rollback is a revert. The marker is additive frontmatter that installed copies simply carry; reporting is informational, so no user state needs undoing.

## Open Questions

None outstanding. The decisions above were settled before implementation; the empirical findings in Context supersede an earlier draft that relied on the tool's canonical directory.
