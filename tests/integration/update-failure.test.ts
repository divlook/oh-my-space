import assert from "node:assert/strict";
import test from "node:test";
import { runUpdate } from "../../scripts/lib/update.js";
import { currentVersion, newerVersion, testEnv } from "../helpers.js";

Object.assign(process.env, testEnv);

test("update normalizes a package-manager failure to exit code one", async () => {
  const keys = [
    "OMS_TEST_MODE",
    "OMS_TEST_PACKAGE_VERSION",
    "OMS_TEST_REGISTRY_RESPONSE",
    "OMS_TEST_INSTALL_CONTEXT",
    "OMS_TEST_MANAGER_AVAILABLE",
    "OMS_TEST_UPDATE_EXIT",
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  let output = "";
  const capture = (chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  process.stdout.write = capture as typeof process.stdout.write;
  process.stderr.write = capture as typeof process.stderr.write;
  try {
    process.env.OMS_TEST_MODE = "1";
    process.env.OMS_TEST_PACKAGE_VERSION = currentVersion;
    process.env.OMS_TEST_REGISTRY_RESPONSE = JSON.stringify({ "dist-tags": { latest: newerVersion } });
    process.env.OMS_TEST_INSTALL_CONTEXT = JSON.stringify({
      kind: "global",
      label: "global npm install",
      updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      guidance: [],
      warnings: [],
    });
    process.env.OMS_TEST_MANAGER_AVAILABLE = "1";
    process.env.OMS_TEST_UPDATE_EXIT = "7";

    assert.equal(await runUpdate({ yes: true, check: false }), 1);
    assert.match(output, /Package manager update failed \(exit 7\)/);
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
