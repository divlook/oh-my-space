import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { testEnv } from "./env.js";
import { parseSkillMetadata, type SkillReference } from "./skill-metadata.js";
import type { SkillFreshness, SkillCompatibility } from "./skill-classification.js";

export type SkillScope = "global" | "project";

export type SkillFinding = {
  name: string;
  freshness: SkillFreshness;
  compatibility: SkillCompatibility;
  installedVersion: string | null;
  installedOmsVersion: string | null;
  reference: SkillReference;
  scopes: SkillScope[];
};

const SKILLS_SOURCE_REPO = "divlook/oh-my-space";
const AGENTS_DIRNAME = ".agents";
const GLOBAL_LOCK_FILENAME = ".skill-lock.json";
const PROJECT_LOCK_FILENAME = "skills-lock.json";

function skillsHomeDir(): string {
  return testEnv("OMS_TEST_SKILLS_HOME") ?? homedir();
}

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
    if (typeof source === "string" && source.startsWith(SKILLS_SOURCE_REPO)) names.add(name);
  }
  return names;
}

function dotDirectories(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}


export function installedSkillMetadata(skillPath: string): { version: string | null; omsVersion: string | null } {
  try {
    return parseSkillMetadata(readFileSync(skillPath, "utf8"));
  } catch {
    return { version: null, omsVersion: null };
  }
}

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

export type InstalledSkill = { scope: SkillScope; name: string; path: string | null; metadata: { version: string | null; omsVersion: string | null } };

export function discoverInstalledSkills(workspaceRoot: string | null, names: string[]): InstalledSkill[] {
  const installations: InstalledSkill[] = [];
  const directoriesByBase = new Map<string, string[]>();
  const metadataByPath = new Map<string, InstalledSkill["metadata"]>();
  for (const search of scopeSearches(workspaceRoot)) {
    const locked = new Set<string>();
    for (const path of search.lockPaths) for (const name of lockedSkillNames(path)) locked.add(name);
    const directories = search.bases.flatMap((base) => {
      let directories = directoriesByBase.get(base);
      if (!directories) {
        directories = dotDirectories(base).map((dir) => join(base, dir, "skills"));
        directoriesByBase.set(base, directories);
      }
      return directories;
    });
    for (const name of names) {
      const path = directories.map((dir) => join(dir, name, "SKILL.md")).find(existsSync) ?? null;
      if (!path && !locked.has(name)) continue;
      let metadata = path ? metadataByPath.get(path) : undefined;
      if (!metadata) {
        metadata = path ? installedSkillMetadata(path) : { version: null, omsVersion: null };
        if (path) metadataByPath.set(path, metadata);
      }
      installations.push({ scope: search.scope, name, path, metadata });
    }
  }
  return installations;
}
