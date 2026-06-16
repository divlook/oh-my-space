import { spawnSync } from "node:child_process";
import { cancel, isCancel, log, select } from "@clack/prompts";
import semver from "semver";
import { PACKAGE_NAME, REGISTRY_TIMEOUT_MS, REGISTRY_URL } from "./constants.js";
import { detectInstallContext, formatCommand } from "./doctor.js";
import { readPackageVersion, runtimePlatform, testEnv } from "./env.js";
import type { InstallContext, PackageManager, UpdateCommand, UpdateOptions } from "./types.js";

async function fetchLatestPackageVersion(): Promise<string> {
  const mocked = testEnv("OMS_TEST_REGISTRY_RESPONSE");
  if (mocked !== undefined) return latestFromRegistryJson(JSON.parse(mocked));
  const failure = testEnv("OMS_TEST_REGISTRY_FAILURE");
  if (failure) throw new Error(failure);

  let response: Response;
  try {
    response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`Could not reach npm registry: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!response.ok) {
    throw new Error(`npm registry request failed with HTTP ${response.status}`);
  }
  try {
    return latestFromRegistryJson(await response.json());
  } catch (e) {
    if (e instanceof Error) throw e;
    throw new Error(`Could not parse npm registry response: ${String(e)}`);
  }
}

function latestFromRegistryJson(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("npm registry response was not a JSON object");
  }
  const distTags = (data as { "dist-tags"?: unknown })["dist-tags"];
  if (!distTags || typeof distTags !== "object" || Array.isArray(distTags)) {
    throw new Error("npm registry response is missing dist-tags.latest");
  }
  const latest = (distTags as { latest?: unknown }).latest;
  if (typeof latest !== "string" || latest.length === 0) {
    throw new Error("npm registry response is missing dist-tags.latest");
  }
  return latest;
}

function compareVersions(currentVersion: string, latestVersion: string): number {
  const current = semver.valid(currentVersion);
  if (!current) throw new Error(`Installed version is not valid semver: ${currentVersion}`);
  const latest = semver.valid(latestVersion);
  if (!latest) throw new Error(`Registry latest version is not valid semver: ${latestVersion}`);
  return semver.compare(current, latest);
}

function isPrereleaseVersion(version: string): boolean {
  const parsed = semver.valid(version);
  if (!parsed) throw new Error(`Installed version is not valid semver: ${version}`);
  return semver.prerelease(parsed) !== null;
}

function printUpdateHeader(currentVersion: string, latestVersion: string): void {
  log.info(`Current version: ${currentVersion}`);
  log.info(`Latest version: ${latestVersion}`);
}

function printInstallContext(context: InstallContext): void {
  log.info(`Detected context: ${context.label}`);
  for (const warning of context.warnings) log.warn(warning);
  if (context.updateCommand) log.info(`Selected command: ${formatCommand(context.updateCommand)}`);
}

function printGuidance(context: InstallContext): void {
  if (context.guidance.length === 0) return;
  log.info("Manual update guidance:");
  for (const command of context.guidance) log.message(`  ${command}`);
}

function channelInstallCommand(manager: PackageManager, tag: "beta" | "latest"): string {
  if (manager === "npm") return `npm install -g ${PACKAGE_NAME}@${tag}`;
  if (manager === "pnpm") return `pnpm add -g ${PACKAGE_NAME}@${tag}`;
  if (manager === "yarn") return `yarn global add ${PACKAGE_NAME}@${tag}`;
  return `bun add -g ${PACKAGE_NAME}@${tag}`;
}

function prereleaseGuidanceManager(context: InstallContext): PackageManager | null {
  return context.manager ?? context.updateCommand?.executable ?? null;
}

function printPrereleaseGuidance(context: InstallContext): void {
  const manager = prereleaseGuidanceManager(context);
  log.info("Prerelease channel guidance:");
  if (manager) {
    log.message(`  Stay on beta manually: ${channelInstallCommand(manager, "beta")}`);
    log.message(`  Return to stable: ${channelInstallCommand(manager, "latest")}`);
    return;
  }
  for (const fallbackManager of ["npm", "pnpm", "yarn", "bun"] as const) {
    log.message(`  ${fallbackManager} beta: ${channelInstallCommand(fallbackManager, "beta")}`);
    log.message(`  ${fallbackManager} stable: ${channelInstallCommand(fallbackManager, "latest")}`);
  }
}

function printPrereleaseStatus(currentVersion: string, latestVersion: string): void {
  log.info(`Installed prerelease version: ${currentVersion}`);
  log.info(`Stable latest version: ${latestVersion}`);
}

function commandAvailability(command: UpdateCommand): boolean {
  const mocked = testEnv("OMS_TEST_MANAGER_AVAILABLE");
  if (mocked !== undefined) return mocked === "1" || mocked === "true";
  const result = spawnSync(command.executable, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: runtimePlatform() === "win32",
  });
  return result.status === 0;
}

function runUpdateCommand(command: UpdateCommand): number {
  const mocked = testEnv("OMS_TEST_UPDATE_EXIT");
  if (mocked !== undefined) {
    log.step(formatCommand(command));
    return Number.parseInt(mocked, 10);
  }
  log.step(formatCommand(command));
  const result = spawnSync(command.executable, command.args, { stdio: "inherit", shell: runtimePlatform() === "win32" });
  if (result.status !== null) return result.status;
  log.error(`Package manager exited from signal ${result.signal ?? "unknown"}.`);
  return 1;
}

function verifyPostUpdate(latestVersion: string): void {
  const mocked = testEnv("OMS_TEST_VERIFY_VERSION");
  const result = mocked !== undefined
    ? { status: 0, stdout: mocked, stderr: "" }
    : spawnSync("oms", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: false });
  if (result.status !== 0) {
    log.warn("Post-update verification could not run oms --version from PATH.");
    return;
  }
  const observed = result.stdout.trim().replace(/^oms\s+/, "");
  if (observed !== latestVersion) {
    log.warn(`Post-update verification saw ${observed || "empty output"}, expected ${latestVersion}.`);
  }
}

async function confirmUpdate(command: UpdateCommand): Promise<boolean | null> {
  const choice = await select({
    message: `Run ${formatCommand(command)}?`,
    options: [
      { value: "yes", label: "Yes, update oms" },
      { value: "no", label: "No, do not update" },
    ],
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return choice === "yes";
}

export async function runUpdate(options: UpdateOptions): Promise<number> {
  let latestVersion: string;
  const currentVersion = readPackageVersion();
  try {
    latestVersion = await fetchLatestPackageVersion();
    const comparison = compareVersions(currentVersion, latestVersion);
    const prerelease = isPrereleaseVersion(currentVersion);
    printUpdateHeader(currentVersion, latestVersion);
    if (prerelease) printPrereleaseStatus(currentVersion, latestVersion);
    if (comparison === 0) {
      if (prerelease) printPrereleaseGuidance(detectInstallContext());
      log.success("oms is up to date.");
      return 0;
    }
    if (comparison > 0) {
      if (prerelease) printPrereleaseGuidance(detectInstallContext());
      log.info("Installed version is newer than the npm registry latest; no downgrade will be performed.");
      return 0;
    }
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    return 1;
  }

  log.warn("Update available.");
  const context = detectInstallContext();
  printInstallContext(context);
  const prerelease = isPrereleaseVersion(currentVersion);
  if (prerelease) {
    log.info("Selected update channel: stable latest (oh-my-space@latest).");
    printPrereleaseGuidance(context);
  }

  if (options.check) {
    if (!context.updateCommand) printGuidance(context);
    return 0;
  }

  if (context.kind !== "global" || !context.updateCommand) {
    log.info("Automatic update is only supported for confident global installs.");
    printGuidance(context);
    return 0;
  }

  const command = context.updateCommand;
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      log.info(`Non-interactive shell detected. Re-run with --yes to execute: ${formatCommand(command)}`);
      return 0;
    }
    const confirmed = await confirmUpdate(command);
    if (!confirmed) {
      log.info("Update cancelled; no changes made.");
      return 0;
    }
  }

  if (!commandAvailability(command)) {
    log.error(`${command.executable} is not executable from PATH. Would have run: ${formatCommand(command)}`);
    return 1;
  }

  const updateExit = runUpdateCommand(command);
  if (updateExit !== 0) {
    log.error(`Package manager update failed (exit ${updateExit}).`);
    return 1;
  }
  verifyPostUpdate(latestVersion);
  log.success("Update command completed.");
  return 0;
}
