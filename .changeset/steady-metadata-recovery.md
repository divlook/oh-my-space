---
"oh-my-space": patch
---

Automatically recover stable release completion when published npm metadata remains temporarily unavailable beyond 31 seconds, without republishing or changing dist-tags. Retry only metadata E404 responses within a bounded polling window and preserve publication identity checks and actionable failure guidance.
