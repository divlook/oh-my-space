## 1. CLI Behavior

- [x] 1.1 Change the skill source constant used by `oms skills` from `divlook/oh-my-space` to `divlook/oh-my-space/skills`.
- [x] 1.2 Ensure `oms skills` prints the scoped project command and scoped global command.
- [x] 1.3 Ensure `oms skills --install [...args]` delegates to `npx skills add divlook/oh-my-space/skills [...args]` while preserving workspace-root resolution, inherited stdio, exit-code forwarding, and opaque extra-argument pass-through.
- [x] 1.4 Ensure outside-workspace and delegation-failure messages print the scoped manual command.

## 2. Documentation

- [x] 2.1 Update README workspace skill examples to use `divlook/oh-my-space/skills`.
- [x] 2.2 Update command-reference text for `oms skills` so command examples use the scoped source path.
- [x] 2.3 Update `oms skills --help` wording to match scoped-source behavior without adding duplicate `npx skills add` examples.

## 3. Delta Specification

- [x] 3.1 Keep the change delta for `ai-workspace-skill` aligned so install, list, delegation, outside-workspace, and failure scenarios expect `npx skills add divlook/oh-my-space/skills`; update the main spec only during archive/sync.
- [x] 3.2 Add or update a scenario stating that listing the scoped source exposes only `oms-workspace`, `oms-pointer`, and `oms-branch`.

## 4. Verification

- [x] 4.1 Update CLI tests that assert printed commands, delegated args, and manual fallback commands exactly use `divlook/oh-my-space/skills`.
- [x] 4.2 Run the full test suite with `npm test`.
- [x] 4.3 Manually verify `npx skills add divlook/oh-my-space/skills --list` reports exactly the three `oms` workspace skills.
