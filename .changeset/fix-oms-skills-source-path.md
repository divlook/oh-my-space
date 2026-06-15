---
"oh-my-space": patch
---

`oms skills` now points to the scoped `divlook/oh-my-space/skills` source so `npx skills add` discovers only the three `oms` workspace skills (`oms-workspace`, `oms-pointer`, `oms-branch`), excluding repository-development skills from agent directories such as `.opencode/skills/`, `.codex/skills/`, and `.claude/skills/`. Affects the printed project/global commands, `--install` delegation, and manual-fallback output.
