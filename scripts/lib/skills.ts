import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "@clack/prompts";
import semver from "semver";
import { parse as parseYaml } from "yaml";
import { MANIFEST_FILENAME } from "./constants.js";
import { readSkillVersions, runtimePlatform, testEnv } from "./env.js";
import { findWorkspaceRoot } from "./git.js";
import type { SkillScope, SkillVersionFinding, SkillVersionState } from "./types.js";

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

/** Valid semver from an installed skill's frontmatter, or null when absent or malformed. */
function installedSkillVersion(skillPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(skillPath, "utf8");
  } catch {
    return null;
  }
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return null;
  let data: unknown;
  try {
    data = parseYaml(frontmatter[1] ?? "");
  } catch {
    return null;
  }
  const version = (data as { metadata?: { version?: unknown } } | null)?.metadata?.version;
  return typeof version === "string" && semver.valid(version) ? version : null;
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

/** Compares an installed version against the reference; a missing or malformed version counts as older. */
function classify(installed: string | null, current: string): SkillVersionState {
  if (installed === null) return "older";
  const comparison = semver.compare(installed, current);
  if (comparison === 0) return "current";
  return comparison > 0 ? "newer" : "older";
}

/**
 * Installed oms skills whose version differs from the one baked into this build. Returns nothing when
 * the baked reference is unavailable, when no skill is installed, or when every install matches.
 * @param workspaceRoot - workspace root for the project scope, or null to check the global scope only
 */
function skillVersionFindings(workspaceRoot: string | null): SkillVersionFinding[] {
  const reference = readSkillVersions();
  if (!reference) return [];

  const searches = scopeSearches(workspaceRoot);
  const lockedByScope = searches.map((search) => {
    const names = new Set<string>();
    for (const lockPath of search.lockPaths) {
      for (const name of lockedSkillNames(lockPath)) names.add(name);
    }
    return names;
  });

  const findings: SkillVersionFinding[] = [];
  for (const name of Object.keys(reference).sort()) {
    const current = reference[name];
    // The reference comes from a build artifact, so it is untrusted here: a non-semver value would
    // make semver.compare throw and turn this informational report into a non-zero exit.
    if (!current || !semver.valid(current)) continue;
    // Group by state and installed version so scopes that drifted the same way share one line, while
    // scopes at different versions stay distinct.
    const grouped = new Map<string, SkillVersionFinding>();
    for (const [index, search] of searches.entries()) {
      const skillPath = locateInstalledSkill(search.bases, name);
      const locked = lockedByScope[index]?.has(name) ?? false;
      if (!skillPath && !locked) continue;

      const installed = skillPath ? installedSkillVersion(skillPath) : null;
      const state = skillPath ? classify(installed, current) : "unverified";
      if (state === "current") continue;

      const key = `${state}:${installed ?? ""}`;
      const existing = grouped.get(key);
      if (existing) existing.scopes.push(search.scope);
      else grouped.set(key, { name, state, installed, current, scopes: [search.scope] });
    }
    findings.push(...grouped.values());
  }
  return findings;
}

/** True when any oms skill appears installed, without comparing versions. */
export function omsSkillsInstalled(workspaceRoot: string | null): boolean {
  const reference = readSkillVersions();
  const names = reference ? Object.keys(reference) : [];
  if (names.length === 0) return false;
  for (const search of scopeSearches(workspaceRoot)) {
    for (const lockPath of search.lockPaths) {
      // Restricted to the names this build knows, so a lock entry for a renamed or removed skill
      // cannot claim an install that skillVersionFindings would then report nothing about.
      const locked = lockedSkillNames(lockPath);
      if (names.some((name) => locked.has(name))) return true;
    }
    if (names.some((name) => locateInstalledSkill(search.bases, name))) return true;
  }
  return false;
}

/** One-line description of a finding, naming the installed version, the current one, and the scopes. */
function describeFinding(finding: SkillVersionFinding): string {
  const scopes = finding.scopes.join(", ");
  if (finding.state === "unverified") {
    return `${finding.name}: installed but its version could not be verified (${scopes})`;
  }
  if (finding.installed === null) {
    return `${finding.name}: skill version unknown, current is ${finding.current} (${scopes})`;
  }
  if (finding.state === "newer") {
    return `${finding.name}: skill ${finding.installed} is newer than this oms knows (${finding.current}) (${scopes})`;
  }
  return `${finding.name}: skill ${finding.installed} is older than ${finding.current} (${scopes})`;
}

/**
 * Reports installed skills that drift from this build, at informational level so the caller's exit
 * code is unaffected — a stale skill degrades an agent's guidance rather than breaking oms, and the
 * global scope reflects state outside the workspace.
 * @param workspaceRoot - workspace root for the project scope, or null to check the global scope only
 */
export function reportSkillVersions(workspaceRoot: string | null): void {
  const findings = skillVersionFindings(workspaceRoot);
  if (findings.length === 0) return;

  const behind = findings.filter((finding) => finding.state !== "newer");
  const ahead = findings.filter((finding) => finding.state === "newer");

  for (const finding of behind) log.info(describeFinding(finding));
  if (behind.length > 0) {
    // Passing skill names makes "skills update" non-interactive and covers both scopes, so no -g/-p.
    const names = [...new Set(behind.map((finding) => finding.name))].join(" ");
    log.message(`Update: npx skills update ${names}`);
  }

  for (const finding of ahead) log.info(describeFinding(finding));
  if (ahead.length > 0) {
    log.message("Your oms may be behind these skills. Update: oms update");
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
