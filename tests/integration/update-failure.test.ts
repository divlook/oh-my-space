import assert from "node:assert/strict";
import test from "node:test";
import { runUpdate } from "../../scripts/lib/update.js";
import { testEnv } from "../helpers.js";

Object.assign(process.env, testEnv);

async function updateWith(registry: { response: string } | { failure: string }) {
  const overrides: Record<string, string | undefined> = {
    OMS_TEST_MODE: "1",
    OMS_TEST_PACKAGE_VERSION: "2.0.0",
    OMS_TEST_REGISTRY_RESPONSE: "response" in registry ? registry.response : undefined,
    OMS_TEST_REGISTRY_FAILURE: "failure" in registry ? registry.failure : undefined,
    OMS_TEST_INSTALL_CONTEXT: JSON.stringify({
      kind: "global", label: "global npm install",
      updateCommand: { executable: "npm", args: ["install", "-g", "oh-my-space@latest"] },
      guidance: [], warnings: [],
    }),
    OMS_TEST_MANAGER_AVAILABLE: "1",
    OMS_TEST_UPDATE_EXIT: "7",
  };
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  const apply = (values: typeof overrides) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
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
    apply(overrides);
    const code = await runUpdate({ yes: true, check: false });
    return { code, output };
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    apply(saved);
  }
}

test("update normalizes a package-manager failure to exit code one", async () => {
  const { code, output } = await updateWith({ response: '{"dist-tags":{"latest":"2.1.0"}}' });
  assert.equal(code, 1);
  assert.match(output, /Package manager update failed \(exit 7\)/);
});

test("update refuses unavailable or invalid registry metadata before installation", async () => {
  const unavailable = await updateWith({ failure: "registry timeout" });
  assert.equal(unavailable.code, 1);
  assert.match(unavailable.output, /registry timeout/);
  const missing = await updateWith({ response: '{"dist-tags":{}}' });
  assert.equal(missing.code, 1);
  assert.match(missing.output, /missing dist-tags.latest/);
  const invalid = await updateWith({ response: '{"dist-tags":{"latest":"not-semver"}}' });
  assert.equal(invalid.code, 1);
  assert.match(invalid.output, /not valid semver/);
  assert.doesNotMatch(unavailable.output + missing.output + invalid.output, /Update available|Package manager update failed/);
});
