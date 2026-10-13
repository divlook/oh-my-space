---
"oh-my-space": patch
---

Make `oms branch clean` output concise when no branches are eligible, while retaining actual initialization effects and safety or shallow-history diagnostics. Keep full plan details and confirmation warnings when deletion candidates exist, and omit routine preparation notices for already initialized sources.

Shorten `oms branch clean --help` to examples and essential guidance, with a link to the detailed safety and recovery rules. Branch eligibility, deletion behavior, and exit codes are unchanged.
