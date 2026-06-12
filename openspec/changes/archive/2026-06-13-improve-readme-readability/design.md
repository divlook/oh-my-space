## Context

The current README is accurate but front-loads implementation details: `oms.yaml`, Git submodules, pinned commits, detached HEAD behavior, remote branch creation, and pointer movement all appear in the opening description. This makes the document useful for readers who already understand the tool, but less effective for first-time readers trying to answer, "What is this and should I use it?"

The redesign should keep the README as the primary package/documentation entry point while separating first-time-reader onboarding from detailed reference material. Existing factual content should be reused where possible.

## Goals / Non-Goals

**Goals:**

- Make the README's first screen identify `oh-my-space` as a small CLI for managing multi-repo workspaces with Git submodules.
- Present user-centered reasons to use the tool before detailed Git/submodule mechanics.
- Convert the current broad quick-start command list into a compact, realistic onboarding flow.
- Preserve command reference, schema rules, requirements, update guidance, and migration links for existing users.
- Align `package.json` description with the new README product-category wording.
- Keep all documentation record text in English.

**Non-Goals:**

- Do not change CLI behavior, command names, options, dependencies, or generated schema files.
- Do not split command reference content into new docs as part of this change.
- Do not add marketing claims that imply `oms` replaces Git, Git submodules, or monorepo tooling.

## Decisions

### Lead with product category, then implementation

Use the opening line: "`oh-my-space` is a small CLI for managing multi-repo workspaces with Git submodules."

Rationale: this establishes the category before explaining `oms.yaml` or submodule mechanics. The implementation remains explicit, but it no longer dominates the first impression.

Alternative considered: lead with "submodule wrapper." This is precise for existing Git submodule users but less accessible to readers who are starting from the multi-repo workspace problem.

### Keep README as one document, reordered by reader journey

Use a two-layer structure:

1. First-time-reader layer: definition, use cases, compact example, layout.
2. Reference layer: install, requirements, command table, update behavior, `oms.yaml`, migrations.

Rationale: the user selected this approach over splitting detailed command content into another document. It reduces scope while still improving the first impression.

Alternative considered: move detailed command descriptions into a separate `docs/commands.md`. This could make the README shorter, but it increases navigation cost and creates more documentation maintenance surface.

### Make Quick Start flow-based instead of exhaustive

The quick start should show a short path such as `oms init`, editing or reviewing `oms.yaml`, `oms sync --all`, `oms switch`, `oms push`, and committing the pointer. The full command table remains below.

Rationale: a quick start should demonstrate how using the tool feels, not enumerate every command.

Alternative considered: keep the current command list in Quick Start. That is comprehensive but reads like reference material.

Refined structure decisions:

- Use workspace-forward copy after the opening line: Git submodules are stated in the first sentence, while the follow-up emphasizes `oms.yaml`, `oms/<alias>/`, pinned commits, and normal branch/pull/push flows.
- Use this opening follow-up structure: "Declare external repositories in `oms.yaml` and sync them into `oms/<alias>/`. Your parent project records each repo's exact commit while you work with normal branch, pull, and push flows."
- Add a `When to use it` section before setup instructions, with the first use case centered on working with several repositories from one project workspace.
- Limit `When to use it` to four bullets: multi-repo workspace, reproducible pins, avoiding detached HEAD during normal submodule work, and seeing pointer changes in `git status` before committing them.
- Keep `Requirements` near the top, before `Install`, but limit it to runtime/user requirements.
- Phrase the Git repository requirement as an action: "Run `oms` from a Git repository. For a new workspace, run `git init` first."
- Move contributor setup commands into a later `Local development` section.
- Put `Install` before `Quick start`.
- Make Quick Start a new-workspace setup flow: `oms init`, edit a minimal one-repo `oms.yaml`, then `oms sync --all` and `oms status`.
- Do not include `git init` in the Quick Start command flow. Keep that prerequisite in `Requirements` so Quick Start stays focused on `oms`.
- Include the YAML language-server schema comment in the Quick Start `oms.yaml` example, even though it makes the example longer, so copy-paste users get editor validation immediately.
- Include `branch: main # optional; defaults to the remote's default branch` in the Quick Start `oms.yaml` example.
- Put `Layout` immediately after Quick Start.
- Show `oms.yaml`, `.gitmodules`, and two repositories under `oms/` in the `Layout` example to connect declaration, submodule metadata, and checked-out working trees.
- Put `Typical branch flow` after `Layout`, using `oms push`, `git status`, then `git commit` to show pointer visibility without redundant `git add`.
- Rename `Why submodules + a wrapper` to `How `oms` uses Git submodules`.
- Rename `Managing source repositories` to `Command reference` so the lower README layer clearly reads as reference material.
- Keep `Command reference` before `oms.yaml format`; the Quick Start already introduces a minimal YAML example, while the command table is likely the next most useful reference.
- Keep `Updating the CLI` as a separate section even though `oms update` appears in the command table, because its safe self-update behavior needs more detail than a table row can carry.
- Move `Local development` near the end of the README, after migration information and before `License`, so contributor setup does not interrupt user onboarding or reference flow.
- Rename `Migrating between versions` to `Migration guides` for a shorter reference-style heading.
- Do not add a table of contents. Keep the first screen focused on the tool definition and onboarding instead of navigation.
- Add only an npm version badge directly under the main heading, while keeping it visually secondary to the opening description.
- Use the default Shields npm version badge style: `[![npm version](https://img.shields.io/npm/v/oh-my-space.svg)](https://www.npmjs.com/package/oh-my-space)`.
- Start that section by clarifying the boundary: "`oms` does not replace Git submodules. It adds a small command layer for the workflow details that make submodules awkward."
- Keep the submodule workflow bullets in this order: local branch work first, avoiding detached HEAD second, pointer visibility third.
- Use `Start branches locally` as the first workflow bullet title, with copy that explains `oms switch` starts a local branch before it exists on the remote and the first `oms push` creates the remote branch.
- Use `Stay on a branch` as the second workflow bullet title, with body copy that mentions `oms sync` attaches the baseline branch at the pinned commit instead of leaving a detached HEAD.
- Use `Keep pointer moves visible` as the third workflow bullet title, with body copy that explains `oms pull` and `oms push` stage the updated gitlink in the parent repo and `oms status` shows drift from the recorded pointer.
- Move the detailed warning that `oms/` must not be gitignored into `How `oms` uses Git submodules`, rather than placing it directly under the Layout diagram.
- Replace informal "foot-guns" wording with clearer language such as "everyday submodule friction" or "common submodule pitfalls".
- Keep the reproducible-sharing limitation as a blockquote, but shorten it to: "`oms` makes local submodule work easier, but reproducible sharing still requires pushing the source commit and committing the parent pointer."
- Avoid semicolon-joined prose in README copy because it reads overly generated and stiff. Prefer short sentences or separate clauses with commas only when natural.
- Use a lightly product-oriented documentation tone: still technical and precise, but more user-facing than a pure reference manual. Avoid exaggerated marketing language.
- Absorb package/command naming into prose instead of standalone metadata lines.
- Explain the package/command relationship in the Install section with wording like "Install `oh-my-space` to use the `oms` command," rather than adding a standalone metadata block near the opening.

### Align package metadata with README positioning

Update `package.json` description to use the same category-level framing as the README opening.

Use separate densities for README and package metadata:

- README opening: "`oh-my-space` is a small CLI for managing multi-repo workspaces with Git submodules."
- `package.json` description: "Manage multi-repo workspaces with Git submodules."

Rationale: npm/GitHub package surfaces often show `package.json` description before the README. Keeping the description aligned prevents first-time readers from encountering the old `oms.yaml`-first framing outside the README.

Alternative considered: leave package metadata unchanged to minimize file scope. This avoids a non-README edit but preserves an inconsistent first impression in package listings.

## Risks / Trade-offs

- Reduced emphasis on submodule mechanics may hide important Git behavior → Keep a dedicated explanation section that still describes pins, pointer movement, detached HEAD avoidance, and the need to commit pointer updates.
- Reordering content may disrupt existing readers who use README as a reference → Keep stable headings for detailed sections where possible and preserve the command table.
- A shorter opening may over-simplify the tool → Use concrete terms (`oms.yaml`, `oms/<alias>/`, Git submodule, exact commit) by the second paragraph or diagram.
- Package metadata wording could drift from README wording later → Use the same core phrase in both places during this change.
- Runtime tests are not necessary for this documentation and package-description change → Use manual documentation review and verify that only `package.json` description changes in package metadata.
