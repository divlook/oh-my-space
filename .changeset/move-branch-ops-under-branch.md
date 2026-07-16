---
"oh-my-space": minor
---

Relocate `oms switch` and `oms checkout` under the `oms branch` group as `oms branch switch [alias] [branch]` and `oms branch checkout [alias] [branch]`, making `oms branch` the single namespace for the full branch lifecycle (`list`, `switch`, `checkout`, `delete`). Their behavior, arguments, and the `switch --from <ref>` option are unchanged — only the parent command moved. The interactive `oms branch` action selector now offers all four lifecycle actions in order.

BREAKING: the top-level `oms switch` and `oms checkout` commands are removed with no deprecated aliases; calling them now fails as an unknown command and exits non-zero. Update every invocation (including scripts and CI) to `oms branch switch` / `oms branch checkout`. See `docs/migrations/0.13.x-to-0.14.0.md` for the 1:1 mapping.
