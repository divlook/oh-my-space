---
"oh-my-space": major
---

Declare each published skill's OMS runtime range independently from its content version and report compatibility separately from skill freshness.

When an installed skill requires a newer runtime, `oms doctor` and the up-to-date `oms update` path prefer a compatible stable release and otherwise recommend the compatible beta channel. The pending release plan also becomes the source of truth for the `1.0.0-beta.sha-*` beta base.
