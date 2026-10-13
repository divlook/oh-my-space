---
"oh-my-space": patch
---

Reduce repeated Git pointer inspection in JSON status by reusing each selected repository's observations within one invocation. Subsequent invocations still read fresh state; output fields and command behavior are unchanged.

Avoid healthy-tree working-file inspection during doctor inventory while preserving complete discovery, broken-link and foreign-directory diagnostics, and tree listing/removal safeguards.

Limit managed-tree working-file inspection to selected aliases in JSON and text status. Unfiltered status and tree listing still report the complete inventory and all dirty states.

Skip unrelated tree working-file checks when detecting duplicate task trees. Healthy, broken, and foreign duplicates still refuse before preparation; normal creation retains its existing Git safeguards.

Skip tree working-file checks in unsync's inventory guard. Healthy, broken, and foreign tree entries still block deletion, including with `--force`; topology transactions and recovery behavior are unchanged.
