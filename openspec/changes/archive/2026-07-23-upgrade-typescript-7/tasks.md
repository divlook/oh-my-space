## 1. Upgrade the dependency

- [x] 1.1 Change the `typescript` devDependency range in `package.json` from `^5.9.3` to `^7.0.2`
- [x] 1.2 Run `npm install` to refresh `package-lock.json` (pulls `typescript@7` and its `@typescript/typescript-*` native binaries)
- [x] 1.3 Confirm no other dependency (`@types/node`, esbuild, etc.) was changed by the install

## 2. Verify the type-check gate

- [x] 2.1 Run `npm run build` and confirm the `tsc --noEmit` gate passes with 0 errors, then esbuild produces `dist/oms.js`
- [x] 2.2 Run `npm test` and confirm the full black-box suite passes against the freshly built bundle
- [x] 2.3 Confirm `tsconfig.json`, `@types/node`, `scripts/**`, and `.github/workflows/**` are unchanged

## 3. Record the release

- [x] 3.1 Add a `patch` changeset for `oh-my-space` describing the TypeScript 7 devDependency bump (English, no user-facing behavior change)
