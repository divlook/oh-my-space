## 1. Map Existing Documentation

- [x] 1.1 Inventory every current README section and assign each subject and safety contract to one destination document.
- [x] 1.2 Identify README anchor links in migration guides and other documentation that must change during the cutover.

## 2. Create Focused User Guides

- [x] 2.1 Create `docs/getting-started.md` with setup, first synchronization, and the complete branch, commit, push, and recorded-commit workflow.
- [x] 2.2 Create `docs/how-oms-works.md` with workspace layout, repository boundaries, recorded commits, synchronization, status, safety behavior, failures, and recovery.
- [x] 2.3 Create `docs/commands.md` with command selection, affected repository boundaries, normal workflows, major safety behavior, and links to authoritative built-in help.
- [x] 2.4 Create `docs/configure-your-workspace.md` with the `oms.yaml` structure, repository declarations, defaults, and configuration examples.
- [x] 2.5 Create `docs/ai-coding-tools.md` with the existing AI agent workflow and workspace skill guidance.
- [x] 2.6 Create `docs/development.md` with contributor setup, build, test, and release guidance, linking to the existing release-channel guide.

## 3. Cut Over README and Migration Navigation

- [x] 3.1 Replace the README with the concise product overview, audience and benefits, requirements, installation, minimal first-use flow, purpose-based documentation links, and license.
- [x] 3.2 Use absolute GitHub `main` branch URLs for README links to detailed documentation while keeping links between files under `docs/` relative.
- [x] 3.3 Add `docs/migrations/README.md` as the migration index and update migration-guide links that target removed README anchors.

## 4. Verify Documentation Contracts

- [x] 4.1 Compare the focused guides against the README inventory and confirm every existing user-facing subject and safety contract has one primary owner.
- [x] 4.2 Verify documented command examples and major behavior against current `oms <command> --help` output without duplicating exact option or exit-code contracts.
- [x] 4.3 Check all Markdown links from the README and within `docs/`, including npm-rendered absolute documentation links.
- [x] 4.4 Review the README and guides for task-oriented English, consistent “recorded commit” terminology, normal-flow-first organization, and explained Git terms.
- [x] 4.5 Remove duplicated explanations after coverage and navigation checks confirm that no required guidance was lost.
