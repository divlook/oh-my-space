import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "@clack/prompts";
import semver from "semver";
import { MANIFEST_FILENAME, PACKAGE_NAME, REGISTRY_TIMEOUT_MS, REGISTRY_URL } from "./constants.js";
import { readPackageVersion, readSkillReferences, runtimePlatform, testEnv } from "./env.js";
import { findWorkspaceRoot } from "./git.js";
import { detectInstallContext } from "./install-context.js";
import { channelInstallCommand, registryDistTagsFromJson, type RegistryDistTags } from "./package-channels.js";
import { parseSkillMetadata } from "./skill-metadata.js";
import type { PackageManager, SkillCompatibility, SkillFinding, SkillFreshness, SkillScope } from "./types.js";

/** npx skills package identifier for the oms workspace skills (scoped to the repository skills/ directory). */
const SKILLS_REPO = "divlook/oh-my-space/skills";

/** The owner/repo portion of SKILLS_REPO — how the skills tool records provenance in its lock files. */
const SKILLS_SOURCE_REPO = SKILLS_REPO.split("/").slice(0, 2).join("/");

/** Home-relative directory the skills tool uses for its own state and canonical skill copies. */
const AGENTS_DIRNAME = ".agents";

/** The skills tool's global lock basename, under AGENTS_DIRNAME or $XDG_STATE_HOME/skills. */
const GLOBAL_LOCK_FILENAME = ".skill-lock.json";

/** The skills tool's project lock basename, written at the directory the install ran from. */
const PROJECT_LOCK_FILENAME = "skills-lock.json";

/** Home directory used to search for globally installed skills; overridable so tests never move HOME. */
function skillsHomeDir(): string {
  return testEnv("OMS_TEST_SKILLS_HOME") ?? homedir();
}

/** Path of the skills tool's global lock. The test override wins over $XDG_STATE_HOME. */
function globalLockPath(): string {
  const overriddenHome = testEnv("OMS_TEST_SKILLS_HOME");
  if (overriddenHome) return join(overriddenHome, AGENTS_DIRNAME, GLOBAL_LOCK_FILENAME);
  const xdgStateHome = process.env.XDG_STATE_HOME;
  if (xdgStateHome) return join(xdgStateHome, "skills", GLOBAL_LOCK_FILENAME);
  return join(homedir(), AGENTS_DIRNAME, GLOBAL_LOCK_FILENAME);
}

/**
 * Names of oms skills recorded in one skills-tool lock file. The lock is an external format that has
 * already changed several times, so anything unreadable or unrecognised yields no names rather than
 * an error; discovery then falls back to searching the filesystem.
 */
function lockedSkillNames(lockPath: string): Set<string> {
  const names = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return names;
  }
  const skills = (parsed as { skills?: unknown } | null)?.skills;
  if (!skills || typeof skills !== "object" || Array.isArray(skills)) return names;
  for (const [name, entry] of Object.entries(skills as Record<string, unknown>)) {
    const source = (entry as { source?: unknown } | null)?.source;
    // Provenance is only available from the lock, and it is present even for installs that predate
    // the version marker; a same-named third-party skill is excluded here.
    if (typeof source === "string" && source.startsWith(SKILLS_SOURCE_REPO)) names.add(name);
  }
  return names;
}

/** Dot-directory names directly under a base path, the shape every agent skills directory takes. */
function dotDirectories(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * Locates an installed SKILL.md under any of the given base paths. The skills tool writes either to
 * its own canonical directory or straight into an agent directory depending on how it was invoked,
 * and the lock records the source path rather than the install path, so the file must be searched for.
 */
function locateInstalledSkill(bases: string[], name: string): string | null {
  for (const base of bases) {
    for (const dotDir of dotDirectories(base)) {
      const candidate = join(base, dotDir, "skills", name, "SKILL.md");
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** Independently verifiable metadata from an installed skill, or null values when unavailable. */
export function installedSkillMetadata(skillPath: string): { version: string | null; omsVersion: string | null } {
  try {
    return parseSkillMetadata(readFileSync(skillPath, "utf8"));
  } catch {
    return { version: null, omsVersion: null };
  }
}

/** Where to look for one scope: several bases to search, and the lock files that cover it. */
type ScopeSearch = { scope: SkillScope; bases: string[]; lockPaths: string[] };

function scopeSearches(workspaceRoot: string | null): ScopeSearch[] {
  const searches: ScopeSearch[] = [
    { scope: "global", bases: [skillsHomeDir()], lockPaths: [globalLockPath()] },
  ];
  if (!workspaceRoot) return searches;
  const bases = [workspaceRoot];
  const cwd = process.cwd();
  // An install run from a subdirectory leaves its lock and files there rather than at the root.
  if (cwd !== workspaceRoot) bases.push(cwd);
  searches.push({
    scope: "project",
    bases,
    lockPaths: bases.map((base) => join(base, PROJECT_LOCK_FILENAME)),
  });
  return searches;
}

/** Compares installed skill content with its baked reference. */
export function classifyFreshness(installed: string | null, current: string, located = true): SkillFreshness {
  if (!located) return "unverified";
  if (installed === null) return "older";
  const comparison = semver.compare(installed, current);
  if (comparison === 0) return "current";
  return comparison > 0 ? "newer" : "older";
}

/** Evaluates the running OMS version against an installed skill's declared range. */
export function classifyCompatibility(omsVersion: string | null, runningVersion: string): SkillCompatibility {
  if (omsVersion === null || !semver.valid(runningVersion)) return "unverified";
  return semver.satisfies(runningVersion, omsVersion) ? "compatible" : "incompatible";
}

/** Classifies both installed-skill dimensions without coupling their outcomes. */
export function classifySkillMetadata(
  installedVersion: string | null,
  referenceVersion: string,
  installedOmsVersion: string | null,
  runningVersion: string,
  located = true,
): { freshness: SkillFreshness; compatibility: SkillCompatibility } {
  return {
    freshness: classifyFreshness(installedVersion, referenceVersion, located),
    compatibility: classifyCompatibility(installedOmsVersion, runningVersion),
  };
}

/** Installed OMS skill findings across independent freshness and compatibility dimensions. */
export function skillFindings(workspaceRoot: string | null, runningVersion = readPackageVersion()): SkillFinding[] {
  const references = readSkillReferences();
  if (!references) return [];

  const searches = scopeSearches(workspaceRoot);
  const lockedByScope = searches.map((search) => {
    const names = new Set<string>();
    for (const lockPath of search.lockPaths) {
      for (const name of lockedSkillNames(lockPath)) names.add(name);
    }
    return names;
  });
  const findings: SkillFinding[] = [];

  for (const name of Object.keys(references).sort()) {
    const reference = references[name];
    if (!reference || !semver.valid(reference.version)) continue;

    const grouped = new Map<string, SkillFinding>();
    for (const [index, search] of searches.entries()) {
      const skillPath = locateInstalledSkill(search.bases, name);
      const locked = lockedByScope[index]?.has(name) ?? false;
      if (!skillPath && !locked) continue;

      const metadata = skillPath
        ? installedSkillMetadata(skillPath)
        : { version: null, omsVersion: null };
      const { freshness, compatibility } = classifySkillMetadata(
        metadata.version,
        reference.version,
        metadata.omsVersion,
        runningVersion,
        skillPath !== null,
      );
      if (freshness === "current" && compatibility === "compatible") continue;

      const key = `${freshness}:${compatibility}:${metadata.version ?? ""}:${metadata.omsVersion ?? ""}`;
      const existing = grouped.get(key);
      if (existing) existing.scopes.push(search.scope);
      else {
        grouped.set(key, {
          name,
          freshness,
          compatibility,
          installedVersion: metadata.version,
          installedOmsVersion: metadata.omsVersion,
          reference,
          scopes: [search.scope],
        });
      }
    }
    findings.push(...grouped.values());
  }
  return findings;
}

/** True when any OMS skill appears installed, without comparing metadata. */
export function omsSkillsInstalled(workspaceRoot: string | null): boolean {
  const reference = readSkillReferences();
  const names = reference ? Object.keys(reference) : [];
  if (names.length === 0) return false;
  for (const search of scopeSearches(workspaceRoot)) {
    for (const lockPath of search.lockPaths) {
      const locked = lockedSkillNames(lockPath);
      if (names.some((name) => locked.has(name))) return true;
    }
    if (names.some((name) => locateInstalledSkill(search.bases, name))) return true;
  }
  return false;
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

async function fetchRegistryDistTags(): Promise<RegistryDistTags> {
  const mocked = testEnv("OMS_TEST_REGISTRY_RESPONSE");
  if (mocked !== undefined) return registryDistTagsFromJson(JSON.parse(mocked));
  const failure = testEnv("OMS_TEST_REGISTRY_FAILURE");
  if (failure) throw new Error(failure);

  let response: Response;
  try {
    response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`Could not reach npm registry: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`npm registry request failed with HTTP ${response.status}`);
  return registryDistTagsFromJson(await response.json());
}

function isPackageManager(value: string | undefined): value is PackageManager {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";
}

function guidanceManager(): PackageManager {
  const context = detectInstallContext();
  if (context.manager) return context.manager;
  const executable = context.updateCommand?.executable;
  return isPackageManager(executable) ? executable : "npm";
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

/**
 * Reports skill freshness and runtime compatibility without changing command exit behavior.
 * @param workspaceRoot - workspace root for project scope, or null for global scope only
 */
export async function reportSkillFindings(workspaceRoot: string | null): Promise<void> {
  try {
    const runningVersion = readPackageVersion();
    const findings = skillFindings(workspaceRoot, runningVersion);
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
      manager = guidanceManager();
      reportChannelRemediation(incompatible, await fetchRegistryDistTags(), manager);
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

/** Extra args forwarded to "npx skills add", read from argv so flags pass through verbatim. */
export function skillsForwardedArgs(): string[] {
  // process.argv: [node, oms.js, "skills", ...rest]; drop the "--install" flag and forward the rest.
  return process.argv.slice(3).filter((arg) => arg !== "--install");
}

/** Print the install commands, or with --install delegate to "npx skills add" from the workspace root. */
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
