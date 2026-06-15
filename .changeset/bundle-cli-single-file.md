---
"oh-my-space": patch
---

build: bundle the CLI into a single dependency-free `dist/oms.js`. The build now type-checks with `tsc --noEmit` and bundles via esbuild, inlining the former runtime dependencies (`commander`, `@clack/prompts`, `semver`, `yaml`) so the published package declares no runtime dependencies. Internally, the monolithic `scripts/oms.ts` was split into cohesive `scripts/lib/*` modules. No user-facing CLI behavior, command surface, or output changes.
