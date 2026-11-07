import { spawnSync } from "node:child_process";
import { log } from "@clack/prompts";
import semver from "semver";
import { MANIFEST_FILENAME, PACKAGE_NAME } from "./constants.js";
import { readPackageVersion, readSkillReferences, runtimePlatform, testEnv } from "./env.js";
import { findWorkspaceRoot } from "./workspace-discovery.js";
import { detectInstallContext, installGuidanceManager } from "./install-context.js";
import { channelInstallCommand, registryDistTagsFromJson, type RegistryDistTags } from "./package-channels.js";
import { discoverInstalledSkills } from "./skill-discovery.js";
import { classifyInstalledSkills } from "./skill-classification.js";
import { fetchRegistryJson } from "./registry.js";
import type { PackageManager } from "./package-install.js";
import type { SkillFinding } from "./skill-discovery.js";

const SKILLS_REPO = "divlook/oh-my-space/skills";



export function omsSkillsInstalled(workspaceRoot: string | null): boolean {
  const reference = readSkillReferences();
  const names = reference ? Object.keys(reference) : [];
  if (names.length === 0) return false;
  return discoverInstalledSkills(workspaceRoot, names).length > 0;
}

function describeFreshness(finding: SkillFinding): string | null {
  const scopes = finding.scopes.join(", ");
  if (finding.freshness === "current") return null;
  if (finding.freshness === "unverified") {
    return `${finding.name}: recorded in the lock file but the skill could not be located (${scopes})`;
  }
  if (finding.installedVersion === null) {
    return `${finding.name}: skill version unknown, current is ${finding.reference.version} (${scopes})`;
  }
  if (finding.freshness === "newer") {
    const compatibility = finding.compatibility === "compatible" ? "; runtime compatibility is satisfied" : "";
    return `${finding.name}: skill ${finding.installedVersion} is newer than this oms knows (${finding.reference.version})${compatibility} (${scopes})`;
  }
  return `${finding.name}: skill ${finding.installedVersion} is older than ${finding.reference.version} (${scopes})`;
}

function describeCompatibility(finding: SkillFinding, runningVersion: string): string | null {
  const scopes = finding.scopes.join(", ");
  if (finding.compatibility === "compatible") return null;
  if (finding.compatibility === "unverified") {
    return `${finding.name}: OMS compatibility could not be verified; update or reinstall the skill (${scopes})`;
  }
  return `${finding.name}: skill ${finding.installedVersion ?? "unknown"} requires oms ${finding.installedOmsVersion}; running oms is ${runningVersion} (${scopes})`;
}



function reportChannelRemediation(findings: SkillFinding[], tags: RegistryDistTags, manager: PackageManager): void {
  for (const finding of findings) {
    const range = finding.installedOmsVersion;
    if (!range) continue;
    if (semver.satisfies(tags.latest, range)) {
      log.message(`${finding.name}: install a compatible stable OMS: ${channelInstallCommand(manager, "latest")}`);
    } else if (tags.beta && semver.satisfies(tags.beta, range)) {
      log.message(`${finding.name}: install a compatible beta OMS: ${channelInstallCommand(manager, "beta")}`);
    } else {
      log.info(`${finding.name}: no compatible published OMS channel was found for ${range}.`);
    }
  }
}

export async function reportSkillFindings(workspaceRoot: string | null): Promise<void> {
  try {
    const runningVersion = readPackageVersion();
    const references = readSkillReferences();
    const findings = references
      ? classifyInstalledSkills(discoverInstalledSkills(workspaceRoot, Object.keys(references)), references, runningVersion)
      : [];
    if (findings.length === 0) return;

    for (const finding of findings) {
      const freshness = describeFreshness(finding);
      if (freshness) log.info(freshness);
      const compatibility = describeCompatibility(finding, runningVersion);
      if (compatibility) log.info(compatibility);
    }

    const skillUpdates = findings.filter((finding) =>
      finding.freshness === "older" || finding.freshness === "unverified" ||
      finding.compatibility === "unverified");
    if (skillUpdates.length > 0) {
      const names = [...new Set(skillUpdates.map((finding) => finding.name))].join(" ");
      log.message(`Update or reinstall: npx skills update ${names}`);
    }

    const incompatible = findings.filter((finding) => finding.compatibility === "incompatible");
    if (incompatible.length === 0) return;

    let manager: PackageManager = "npm";
    try {
      manager = installGuidanceManager(detectInstallContext()) ?? "npm";
    } catch {
      // Install evidence is advisory; unavailable guidance must not suppress channel inspection.
    }
    try {
      reportChannelRemediation(incompatible, registryDistTagsFromJson(await fetchRegistryJson()), manager);
    } catch (error) {
      log.info(`Could not resolve compatible npm channels: ${error instanceof Error ? error.message : String(error)}`);
      log.message(`Inspect channels: npm view ${PACKAGE_NAME} dist-tags`);
      log.message(`Stable: ${channelInstallCommand(manager, "latest")}`);
      log.message(`Beta: ${channelInstallCommand(manager, "beta")}`);
    }
  } catch (error) {
    log.info(`Could not inspect installed OMS skills: ${error instanceof Error ? error.message : String(error)}`);
  }
}


export async function runSkills(install: boolean, extraArgs: string[]): Promise<number> {
  const projectCommand = `npx skills add ${SKILLS_REPO}`;
  const globalCommand = `${projectCommand} -g`;

  if (!install) {
    log.info("Install the oms workspace skills with the skills tool:");
    log.message(`  ${projectCommand}        # project scope (run at the workspace root)`);
    log.message(`  ${globalCommand}     # global scope (every workspace)`);
    log.message("Add --skill <name> to install one (oms-workspace, oms-pointer, oms-branch), or --list to list them.");
    return 0;
  }

  const wantsGlobal = extraArgs.includes("-g") || extraArgs.includes("--global");
  const workspaceRoot = findWorkspaceRoot();
  if (!workspaceRoot && !wantsGlobal) {
    log.error(
      `"oms skills --install" must run inside an ${MANIFEST_FILENAME} workspace. ` +
        `For a global install from anywhere, run: ${globalCommand}`,
    );
    return 1;
  }

  const args = ["skills", "add", SKILLS_REPO, ...extraArgs];
  const npxBin = testEnv("OMS_NPX_BIN") ?? "npx";
  const result = spawnSync(npxBin, args, {
    stdio: "inherit",
    cwd: workspaceRoot ?? process.cwd(),
    shell: runtimePlatform() === "win32",
  });
  if (result.error || result.status === null) {
    log.error(`Could not run "${[npxBin, ...args].join(" ")}".`);
    log.message(`Install the skills manually: ${projectCommand}`);
    return 1;
  }
  return result.status;
}
