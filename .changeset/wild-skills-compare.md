---
"oh-my-space": minor
---

Version the published workspace skills and report installed copies that have drifted.

Each skill now declares `metadata.author` and `metadata.version` in its `SKILL.md` frontmatter, and the build bakes those versions into the CLI. `oms doctor` compares installed copies against them and names the command that resolves the difference: `npx skills update <name...>` when a skill is older, or `oms update` when a skill is newer than the running CLI knows. Copies installed before versions existed report as unknown and are treated as older.

Installed skills are found through the `skills` tool's lock files and a search of agent skill directories, so every install layout the tool writes is covered. `oms update` runs the same check when `oms` is already up to date, and points back at `oms doctor` after upgrading the CLI, since the new version is not loaded in that process.

These findings are informational and never change an exit code.
