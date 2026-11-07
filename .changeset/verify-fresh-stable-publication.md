---
"oh-my-space": patch
---

Revalidate stable publication metadata with npm and retry only E404 visibility failures before creating GitHub release metadata. Bound retries to six queries with 31 seconds of scheduled waits, preserve immediate failure for other errors or identity mismatches, and retain metadata-only recovery without republishing packages.
