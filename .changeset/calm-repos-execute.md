---
"oh-my-space": minor
---

Add `oms exec` to run literal commands sequentially across selected initialized canonical source repositories without automatic preparation. Stream child output, report per-alias results, continue after target failures, and stop later targets on Ctrl+C while preserving child effects. Document selection, stdin consumption, exit codes, explicit shell invocation, and interruption limits.

Clarify the execution guides with shorter sentences and separate selection, input, result, and interruption rules.
Add execution instructions to `oms-workspace` version 1.4.0.
Require OMS >=1.2.0-0 for that skill, including beta releases of the new command.
Keep managed-tree checks in their task checkout.
Leave the always-on repository instruction block unchanged.
