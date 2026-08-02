## Context

`README.md` is currently both the product landing page and the main operational reference. Its 351 lines cover onboarding, workspace mechanics, command behavior, configuration, AI coding workflows, migrations, and contributor instructions. This gives existing users substantial detail, but makes first-time evaluation difficult and leaves unrelated audiences sharing one long navigation structure.

The existing `docs/` directory contains release-channel and migration material but no clear path from installation to everyday use. Some migration content links to README section anchors, so moving sections without updating those links would break navigation. The npm package includes `README.md` but excludes `docs/`, while package metadata points to the GitHub repository.

The documentation must remain accurate about Git repository boundaries and safety behavior without requiring readers to understand OMS implementation details. Exact command arguments, options, and exit codes already have an authoritative source in `oms <command> --help`.

## Goals / Non-Goals

**Goals:**

- Make the README a concise landing page that helps a new reader understand, install, and first run OMS.
- Give each major reader intent one clearly owned document and a direct link from the README.
- Preserve current operational, safety, migration, AI-tooling, and contributor guidance while rewriting it in plain, task-oriented English.
- Use consistent names for recurring concepts and explain unavoidable Git terminology at first use.
- Keep command documentation and built-in help complementary rather than duplicating exact contracts.
- Keep links usable from both GitHub and the README rendered on npm.

**Non-Goals:**

- Change CLI behavior, command syntax, configuration semantics, package dependencies, or runtime code.
- Teach Git fundamentals such as branches, commits, pull, and push.
- Rewrite historical migration instructions except where wording or links must change for the new structure.
- Publish the full `docs/` directory in the npm package.
- Introduce a documentation generator, site framework, or automated content synchronization system.

## Decisions

### 1. Keep only the shortest successful setup path in the README

The README will contain the product definition, primary benefits, requirements, installation, a minimal `oms init` → configure one repository → `oms sync --all` → `oms status` flow, purpose-based documentation links, and the license. The detailed commit, push, and record workflow will move to the getting-started guide.

This keeps the landing page useful without requiring readers to understand recorded submodule commits before they have tried the product. Retaining the complete daily workflow in the README was considered, but rejected because it recreates the current mix of introduction and operational reference.

### 2. Split documentation by reader task

Detailed content will be organized as follows:

- `docs/getting-started.md`: setup, first synchronization, and the first complete branch/commit/push/record workflow.
- `docs/how-oms-works.md`: workspace layout, repository boundaries, recorded commits, synchronization, status, branch safety, failure behavior, and recovery.
- `docs/commands.md`: a command-selection guide, affected repository boundaries, and major behavior; exact flags and exit codes remain in built-in help.
- `docs/configure-your-workspace.md`: the `oms.yaml` structure, repository declarations, defaults, and configuration examples.
- `docs/ai-coding-tools.md`: workspace skills and guidance for AI coding tools.
- `docs/development.md`: contributor setup, build, test, and release-oriented development guidance, linking to the existing release-channel document where appropriate.
- `docs/migrations/README.md`: an upgrade index linking to version-specific migration guides.
- `docs/release-channels.md`: remains the focused release-channel guide.

A single large `docs/reference.md` was considered, but rejected because it would reproduce the README's mixed audiences under a different filename. A separate troubleshooting document is not introduced initially; recovery guidance stays beside the relevant workspace behavior so users do not need to search another document.

### 3. Give every fact one primary owner

The README owns product positioning and the minimum first-use path. The getting-started guide owns the complete beginner workflow. The workspace guide owns Git boundaries and safety guarantees. The command guide owns command selection and major observable behavior. Configuration, AI tooling, development, release channels, and migrations each have their own focused owner.

Other documents will link to the owner instead of repeating full explanations. Built-in help remains authoritative for exact arguments, options, and exit codes. This avoids drift while preserving enough context in prose to choose and safely run a command.

Duplicating the existing command reference into `docs/commands.md` was considered, but rejected because the generated CLI behavior can change independently and already exposes exact usage through `--help`.

### 4. Use plain language without hiding necessary Git concepts

Documentation will lead with the user-visible outcome, then explain mechanics only when they affect a decision or recovery step. Normal workflows and exceptional behavior will use separate subsections. Sentences will carry one main idea, examples will precede edge cases, and safety restrictions will state both the restriction and its user-facing reason.

Recurring vocabulary will use one preferred expression. In particular, user-facing text will prefer “the commit recorded by the main project” or the shorter “recorded commit” over interchangeable terms such as root pointer, gitlink, pinned commit, and recorded checkout. Terms that appear in Git or OMS output, such as “detached HEAD,” `stale`, and `unavailable`, will follow a plain explanation rather than replace it.

Removing every technical term was considered, but rejected because users still need to recognize terms shown by Git and the CLI. A separate glossary was also rejected as the primary solution because it forces readers to translate while reading; terms will be explained inline where first needed.

### 5. Keep detailed safety contracts, but move implementation details out of the main flow

Protected branches, commit identity rechecks, preparation classification, metadata updates, partial success, preserved state, and recovery commands will remain documented where they change user expectations. Low-level mechanisms such as temporary Git indexes or file permissions will be omitted from general user guidance unless they are necessary to diagnose or recover from a failure.

Deleting these details entirely was rejected because repository boundaries and recovery guarantees are part of the product contract. Keeping all implementation detail was also rejected because it obscures the action a user should take.

### 6. Host detailed documentation on GitHub without expanding the npm package

The README's documentation navigation will use absolute links under `https://github.com/divlook/oh-my-space/blob/main/docs/` so links work when npm renders the packaged README. Links between files under `docs/` will remain relative for local and GitHub navigation. The npm `files` list will remain unchanged, so installing the CLI does not add documentation files that the runtime does not use.

Adding `docs/` to the npm package was considered, but rejected because offline documentation was not an existing product guarantee and the CLI already provides offline command help.

## Risks / Trade-offs

- **Documentation can lose a safety detail during the move** → Map every current README section to one destination before removing it, then compare the resulting documents against the original section inventory.
- **Command prose can drift from actual CLI behavior** → Describe command purpose and boundaries in docs, defer exact syntax to `--help`, and verify command examples against the current CLI help source.
- **Absolute GitHub links can break if the repository or default branch is renamed** → Limit absolute links to the npm-facing README; keep internal documentation links relative.
- **The new document set can feel fragmented** → Provide purpose-based navigation in the README and cross-link only to the primary owner of the next task.
- **Simpler wording can become technically ambiguous** → Keep exact terms when they affect commands or recovery, but introduce them after a plain-language explanation.
- **Historical migration links can break when README anchors disappear** → Replace each affected anchor link with the new owning document and section.

## Migration Plan

1. Build a section inventory for the current README and assign each section to one destination document.
2. Create the focused documents and move or rewrite their assigned content without deleting source sections yet.
3. Replace the README with the concise landing-page structure and absolute GitHub documentation links.
4. Add the migration index and update existing migration links that target removed README anchors.
5. Check all Markdown links and examples, and compare documented command behavior with built-in help.
6. Remove duplicated text after confirming every required contract has one remaining owner.

This is a documentation-only cutover. If navigation or content coverage is incomplete, the change can be rolled back by restoring the previous README and every existing document changed by the cutover, including migration-guide links, then removing the newly introduced documentation files.

## Open Questions

- None. The README boundary, document ownership, terminology approach, and npm link strategy are resolved by this design.
