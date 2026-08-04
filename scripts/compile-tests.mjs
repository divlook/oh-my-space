import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";

rmSync(".test-dist", { recursive: true, force: true });
const result = spawnSync(process.execPath, [resolve("node_modules/typescript/bin/tsc"), "-p", "tsconfig.test.json"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
