---
"oh-my-space": patch
---

Use the nearest `oms.yaml` without falling back past an invalid candidate, and reject submodule operations when that manifest is below a different Git top-level. Move a nested manifest to the enclosing Git root or initialize a separate repository at the intended workspace root before retrying.
