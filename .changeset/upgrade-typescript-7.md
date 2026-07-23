---
"oh-my-space": patch
---

Upgrade the `typescript` devDependency to `^7.0.2` so the build's `tsc --noEmit` type-check gate runs on the maintained TypeScript 7 compiler line. TypeScript is dev-only and esbuild owns emit, so the published `dist/oms.js` and runtime behavior are unchanged.
