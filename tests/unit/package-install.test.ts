import assert from "node:assert/strict";
import test from "node:test";
import { packageInstallCommand, formatCommand } from "../../scripts/lib/package-install.js";
test("install command selection preserves package-manager-specific executable and arguments", () => {
  assert.deepEqual(packageInstallCommand("npm"), { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] });
  assert.deepEqual(packageInstallCommand("pnpm"), { executable: "pnpm", args: ["add", "-g", "oh-my-space@latest"] });
  assert.deepEqual(packageInstallCommand("yarn"), { executable: "yarn", args: ["global", "add", "oh-my-space@latest"] });
  assert.deepEqual(packageInstallCommand("bun"), { executable: "bun", args: ["add", "-g", "oh-my-space@latest"] });
  assert.equal(formatCommand({ executable: "pnpm", args: ["add", "-g", "oh-my-space@latest"] }), "pnpm add -g oh-my-space@latest");
});
