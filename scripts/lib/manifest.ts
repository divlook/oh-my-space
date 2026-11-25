import { readFileSync } from "node:fs";
import { log } from "@clack/prompts";
import { parse as parseYaml } from "yaml";
import {
  ALIAS_PATTERN,
  MANIFEST_FILENAME,
  REMOTE_NAME_PATTERN,
  REMOTES_MIGRATION_DOC,
} from "./constants.js";
import { docUrl } from "./env.js";
import { resolveWorkspaceManifest } from "./workspace-discovery.js";
import type { Repo, WorkspaceOptions } from "./types.js";
const ALLOWED_ITEM_KEYS = new Set(["alias", "remotes", "branch"]);

type Manifest = { repos: Repo[]; autoCommitRegistration: boolean };
type LoadedWorkspace = Manifest & { repoRoot: string };

function validateManifest(data: unknown, allowLegacyRegistration: boolean): Manifest {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${MANIFEST_FILENAME}: root must be a mapping`);
  }
  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key === "autoCommit") {
      throw new Error(`${MANIFEST_FILENAME}: "autoCommit" is a legacy setting. Resolve it with OMS 2.x before migrating.`);
    }
    if (key === "autoCommitRegistration" && !allowLegacyRegistration) {
      throw new Error(`${MANIFEST_FILENAME}: autoCommitRegistration is a legacy setting. Run oms migrate --dry-run.`);
    }
    if (key !== "repos" && key !== "autoCommitRegistration") {
      throw new Error(`${MANIFEST_FILENAME}: unknown top-level key "${key}"`);
    }
  }
  const { repos, autoCommitRegistration = false } = obj;
  if (typeof autoCommitRegistration !== "boolean") {
    throw new Error(`${MANIFEST_FILENAME}: "autoCommitRegistration" must be a boolean`);
  }
  if (!Array.isArray(repos)) {
    throw new Error(`${MANIFEST_FILENAME}: "repos" must be an array`);
  }
  if (repos.length === 0) {
    throw new Error(`${MANIFEST_FILENAME}: "repos" must have at least one item`);
  }

  const validated: Repo[] = [];
  const seen = new Set<string>();

  repos.forEach((item, idx) => {
    const where = `repos[${idx}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${MANIFEST_FILENAME}: ${where} must be a mapping`);
    }
    const r = item as Record<string, unknown>;
    // Friendlier than "unknown key url": the 0.7.0 manifest replaced url with a remotes mapping.
    if ("url" in r && !("remotes" in r)) {
      throw new Error(
        `${MANIFEST_FILENAME}: ${where}.url is no longer supported; use a "remotes" mapping with an "origin" entry. See ${docUrl(REMOTES_MIGRATION_DOC)}`,
      );
    }
    for (const key of Object.keys(r)) {
      if (!ALLOWED_ITEM_KEYS.has(key)) {
        throw new Error(`${MANIFEST_FILENAME}: ${where} has unknown key "${key}"`);
      }
    }
    if (typeof r.alias !== "string" || r.alias.length === 0) {
      throw new Error(`${MANIFEST_FILENAME}: ${where} missing required "alias"`);
    }
    if (!ALIAS_PATTERN.test(r.alias)) {
      throw new Error(
        `${MANIFEST_FILENAME}: ${where}.alias "${r.alias}" must match ${ALIAS_PATTERN}`,
      );
    }
    if (seen.has(r.alias)) {
      throw new Error(`${MANIFEST_FILENAME}: duplicate alias "${r.alias}"`);
    }
    seen.add(r.alias);
    if (!r.remotes || typeof r.remotes !== "object" || Array.isArray(r.remotes)) {
      throw new Error(`${MANIFEST_FILENAME}: ${where} missing required "remotes" mapping`);
    }
    const remoteEntries = Object.entries(r.remotes as Record<string, unknown>);
    if (remoteEntries.length === 0) {
      throw new Error(`${MANIFEST_FILENAME}: ${where}.remotes must have at least one remote`);
    }
    const remotes: Record<string, string> = {};
    for (const [name, url] of remoteEntries) {
      if (!REMOTE_NAME_PATTERN.test(name)) {
        throw new Error(
          `${MANIFEST_FILENAME}: ${where}.remotes name "${name}" must match ${REMOTE_NAME_PATTERN}`,
        );
      }
      if (typeof url !== "string" || url.length === 0) {
        throw new Error(
          `${MANIFEST_FILENAME}: ${where}.remotes.${name} must be a non-empty string URL`,
        );
      }
      remotes[name] = url;
    }
    if (!remotes.origin) {
      throw new Error(`${MANIFEST_FILENAME}: ${where}.remotes must include an "origin" entry`);
    }
    let branch: string | undefined;
    if (r.branch !== undefined) {
      if (typeof r.branch !== "string" || r.branch.length === 0) {
        throw new Error(`${MANIFEST_FILENAME}: ${where}.branch must be a non-empty string`);
      }
      branch = r.branch;
    }
    validated.push({ alias: r.alias, remotes, branch });
  });

  return { repos: validated, autoCommitRegistration };
}

export function validateSources(data: unknown): Repo[] {
  return validateManifest(data, false).repos;
}

export function parseManifest(text: string, allowLegacyRegistration = false): Manifest {
  return validateManifest(parseYaml(text), allowLegacyRegistration);
}

export function loadRepos(options: WorkspaceOptions & { allowLegacyRegistration?: boolean } = {}): LoadedWorkspace | null {
  const resolution = resolveWorkspaceManifest(options);
  if (resolution.kind === "missing") {
    log.error(
      `Could not find ${MANIFEST_FILENAME} in the current directory or its parents. Create a ${MANIFEST_FILENAME} in this project, then retry.`,
    );
    return null;
  }
  if (resolution.kind === "invalid") {
    log.error(
      `Found ${MANIFEST_FILENAME} at ${resolution.manifestPath}, but ${resolution.reason}. ` +
        "Replace that entry with a regular file; OMS will not fall back to an ancestor manifest.",
    );
    return null;
  }

  try {
    return {
      ...parseManifest(readFileSync(resolution.manifestPath, "utf8"), options.allowLegacyRegistration),
      repoRoot: resolution.repoRoot,
    };
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    return null;
  }
}
