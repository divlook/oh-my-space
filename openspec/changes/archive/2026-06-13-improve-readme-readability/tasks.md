## 1. README Opening

- [x] 1.1 Replace the opening description with a concise product-category statement centered on multi-repo workspaces with Git submodules.
- [x] 1.2 Add a short follow-up explanation that introduces `oms.yaml`, `oms/<alias>/`, exact commit recording, and friendly workflow commands without overloading the first paragraph.
- [x] 1.3 Add or revise early use-case bullets that explain when a reader should use `oms`.
- [x] 1.4 Replace standalone package/command metadata lines with prose that explains the package installs the `oms` command.
- [x] 1.5 Add an npm version badge near the top without letting it dominate the first screen.

## 2. README Structure

- [x] 2.1 Reorder top-level sections so onboarding content appears before detailed reference content.
- [x] 2.2 Convert Quick Start into a compact workflow example rather than an exhaustive command list, while keeping the schema comment and optional `branch` note in the minimal `oms.yaml` example.
- [x] 2.3 Keep the workspace layout explanation near the onboarding flow and show `oms.yaml`, `.gitmodules`, and multiple repositories under `oms/` so readers can visualize the multi-repo model.
- [x] 2.4 Keep runtime requirements before installation, but move local development commands to a later contributor-focused section.
- [x] 2.5 Rename the submodule explanation section to `How `oms` uses Git submodules` and use clearer wording for submodule friction.
- [x] 2.6 Rename the detailed command table section to `Command reference`.

## 3. Reference Preservation

- [x] 3.1 Preserve requirements, install guidance, command reference, update behavior, `oms.yaml` rules, and migration links after the onboarding sections.
- [x] 3.2 Ensure submodule-specific details remain documented, including pointer movement visibility, detached HEAD avoidance, and the need to commit pointer updates.

## 4. Package Metadata

- [x] 4.1 Update `package.json` description to align with the README's product-category framing.
- [x] 4.2 Confirm no package behavior, dependencies, scripts, or version fields changed.

## 5. Verification

- [x] 5.1 Review the final README from a first-time-reader perspective and confirm the tool category is clear in the first screen.
- [x] 5.2 Verify the README still contains or links to the detailed information needed by existing users.
- [x] 5.3 Review README prose for stiff generated phrasing, including semicolon-joined sentences.
- [x] 5.4 Confirm no runtime code changed and `package.json` changes are limited to the description.
