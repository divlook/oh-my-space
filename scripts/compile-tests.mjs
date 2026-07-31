import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

rmSync(".test-dist", { recursive: true, force: true });
const executable = process.platform === "win32" ? "tsc.cmd" : "tsc";
const result = spawnSync(executable, ["-p", "tsconfig.test.json"], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
