import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test, { after } from "node:test";
import { detectInstallContext } from "../../scripts/lib/install-context.js";
import { packageInstallCommand } from "../../scripts/lib/package-install.js";
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("install context detects global package managers from runtime evidence", () => {
  const envKeys = [
    "OMS_TEST_MODE",
    "OMS_TEST_RUNTIME_EVIDENCE",
    "OMS_TEST_PLATFORM",
    "OMS_TEST_MODULE_PATH",
    "OMS_TEST_ARGV1",
    "OMS_TEST_PATH_BIN",
    "PATH",
    "PATHEXT",
  ];
  const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.OMS_TEST_MODE = "1";
    const cases = [
      {
        evidence: {
          packageRoot: "/npm/lib/node_modules/oh-my-space",
          realPackageRoot: "/npm/lib/node_modules/oh-my-space",
          runningBin: "/npm/lib/node_modules/oh-my-space/dist/oms.js",
          realRunningBin: "/npm/lib/node_modules/oh-my-space/dist/oms.js",
          pathBin: "/npm/bin/oms",
          realPathBin: "/npm/bin/oms",
          packageName: "oh-my-space",
        },
        manager: "npm",
      },
      {
        evidence: {
          packageRoot: "/npm/lib/node_modules/oh-my-space",
          realPackageRoot: "/npm/lib/node_modules/oh-my-space",
          runningBin: "/npm/lib/node_modules/oh-my-space/dist/oms.js",
          realRunningBin: "/npm/lib/node_modules/oh-my-space/dist/oms.js",
          pathBin: "/npm/bin/oms",
          realPathBin: "/npm/lib/node_modules/oh-my-space/dist/oms.js",
          packageName: "oh-my-space",
        },
        manager: "npm",
      },
      {
        evidence: {
          packageRoot: "C:\\Users\\me\\AppData\\Roaming\\npm\\lib\\node_modules\\oh-my-space",
          realPackageRoot: "C:\\Users\\me\\AppData\\Roaming\\npm\\lib\\node_modules\\oh-my-space",
          runningBin: "C:\\Users\\me\\AppData\\Roaming\\npm\\lib\\node_modules\\oh-my-space\\dist\\oms.js",
          realRunningBin: "C:\\Users\\me\\AppData\\Roaming\\npm\\lib\\node_modules\\oh-my-space\\dist\\oms.js",
          pathBin: "C:\\Users\\me\\AppData\\Roaming\\npm\\bin\\oms.cmd",
          realPathBin: "C:\\Users\\me\\AppData\\Roaming\\npm\\bin\\oms.cmd",
          packageName: "oh-my-space",
        },
        manager: "npm",
      },
      {
        evidence: {
          packageRoot: "/pnpm/global/5/node_modules/oh-my-space",
          realPackageRoot: "/pnpm/global/5/node_modules/oh-my-space",
          runningBin: "/pnpm/global/5/node_modules/oh-my-space/dist/oms.js",
          realRunningBin: "/pnpm/global/5/node_modules/oh-my-space/dist/oms.js",
          pathBin: "/pnpm/oms",
          realPathBin: "/pnpm/oms",
          packageName: "oh-my-space",
        },
        manager: "pnpm",
      },
    ];
    for (const { evidence, manager } of cases) {
      process.env.OMS_TEST_RUNTIME_EVIDENCE = JSON.stringify(evidence);
      const context = detectInstallContext();
      assert.equal(context.kind, "global");
      assert.equal(context.manager, manager);
      assert.deepEqual(context.updateCommand, packageInstallCommand(manager as "npm" | "pnpm"));
    }

    const root = mkdtempSync(join(tmpdir(), "oms-win-path-"));
    roots.push(root);
    const packageRoot = join(root, "lib", "node_modules", "oh-my-space");
    const modulePath = join(packageRoot, "dist", "oms.js");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "oh-my-space" }));
    writeFileSync(modulePath, "");
    writeFileSync(join(root, "bin", "oms.cmd"), "");
    delete process.env.OMS_TEST_RUNTIME_EVIDENCE;
    delete process.env.OMS_TEST_PATH_BIN;
    process.env.OMS_TEST_PLATFORM = "win32";
    process.env.OMS_TEST_MODULE_PATH = modulePath;
    process.env.OMS_TEST_ARGV1 = modulePath;
    process.env.PATH = `${join(root, "bin")}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ""}`;
    process.env.PATHEXT = ".CMD;.PS1;.EXE";
    const windowsContext = detectInstallContext();
    assert.equal(windowsContext.kind, "global");
    assert.equal(windowsContext.manager, "npm");
  } finally {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }

});
