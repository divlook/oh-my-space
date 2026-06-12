## Why

The README currently describes implementation details before establishing what `oh-my-space` is, making the tool harder to understand for first-time readers. Improving the top-level narrative will help users quickly recognize `oms` as a multi-repo workspace CLI backed by Git submodules, while preserving the existing reference material for users who need details.

## What Changes

- Reframe the README opening around the product category: a small CLI for managing multi-repo workspaces with Git submodules.
- Restructure the README so first-time-reader content appears before detailed reference content.
- Replace the current long introductory explanation with a shorter definition, practical use cases, and a compact usage example.
- Align package metadata description with the new README positioning so npm/GitHub surfaces the same product category.
- Keep existing command details, requirements, update guidance, schema information, and migration links available in the README.
- Avoid changing CLI behavior, command semantics, dependencies, or documentation records outside the README unless needed for consistency.

## Capabilities

### New Capabilities
- `readme-onboarding`: Defines the expected onboarding quality and structure of the project README for first-time readers.

### Modified Capabilities

## Impact

- Affected files: `README.md`, `package.json`, and OpenSpec change artifacts only.
- No runtime code, CLI behavior, dependencies, APIs, or package distribution behavior should change.
