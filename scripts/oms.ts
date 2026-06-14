#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { cancel, isCancel, log, multiselect, select, text } from "@clack/prompts";
import semver from "semver";
import { parse as parseYaml } from "yaml";

type Repo = {
  alias: string;
  /** Named git remotes; must include "origin". Maps remote name to its clonable URL. */
  remotes: Record<string, string>;
  branch?: string;
};

type SourcesOptions = {
  all?: boolean;
  list?: boolean;
};

type UnsyncOptions = SourcesOptions & {
  force?: boolean;
  commit?: boolean;
};

type PushOptions = {
  commit?: boolean;
  record?: boolean;
};

type StatusOptions = SourcesOptions & {
  json?: boolean;
};

type CommitOptions = {
  /** Repeated -m values, passed through to the submodule's git commit. */
  message?: string[];
};

type SyncCommitOptions = SourcesOptions & {
  commit?: boolean;
};

type AgentTarget = "agents" | "claude" | "both";

type AgentOptions = {
  /** Raw --target value from the CLI; validated to AgentTarget at runtime. */
  target?: string;
};

type RemoteOptions = {
  /** Remote name(s) requested via repeatable --remote; empty/undefined means "resolve interactively or default to origin". */
  remote?: string[];
};

type CheckoutOptions = {
  from?: string;
};

type WorkspaceOptions = {
  cwd?: string;
};

type UpdateOptions = {
  check?: boolean;
  yes?: boolean;
};

type OperationResult =
  | "added"
  | "updated"
  | "fetched"
  | "pulled"
  | "pushed"
  | "unsynced"
  | "failed";

type RemoveOutcome = "removed" | "nothing-to-remove" | "failed";

type GitResult = {
  exitCode: number | null;
  success: boolean;
  stdout: string;
};

type ManageCommand = "fetch" | "pull" | "push";

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

type InstallContextKind = "global" | "project" | "ephemeral" | "development" | "unknown";

type UpdateCommand = {
  executable: PackageManager;
  args: string[];
};

type InstallContext = {
  kind: InstallContextKind;
  label: string;
  manager?: PackageManager;
  updateCommand?: UpdateCommand;
  guidance: string[];
  warnings: string[];
};

type RuntimeEvidence = {
  packageRoot: string;
  realPackageRoot: string;
  runningBin: string;
  realRunningBin: string;
  pathBin: string | null;
  realPathBin: string | null;
  packageName: string | null;
};

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_@-]*$/;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ALLOWED_TOP_KEYS = new Set(["repos"]);
const ALLOWED_ITEM_KEYS = new Set(["alias", "remotes", "branch"]);
const MANIFEST_FILENAME = "oms.yaml";
const DATA_DIRNAME = "oms";
const GITIGNORE_ENTRY = `${DATA_DIRNAME}/`;
const GITIGNORE_COMMENT = "# managed by oms";
const LEGACY_MANIFEST = "sources.yaml";
const LEGACY_DATA_DIRNAME = "sources";
const RENAME_MIGRATION_DOC = "docs/migrations/0.3.x-to-0.4.0.md";
const WORKTREE_MIGRATION_DOC = "docs/migrations/0.5.x-to-0.6.0.md";
const REMOTES_MIGRATION_DOC = "docs/migrations/0.6.x-to-0.7.0.md";
/** GitHub blob base for the clickable doc permalinks shown in CLI messages. */
const DOCS_REPO_BLOB_BASE = "https://github.com/divlook/oh-my-space/blob";
const MIN_GIT_MAJOR = 2;
const MIN_GIT_MINOR = 40;
const PACKAGE_NAME = "oh-my-space";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;
const REGISTRY_TIMEOUT_MS = 10_000;

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const useColor = process.stdout.isTTY;
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);

function isTestMode(): boolean {
  return process.env.OMS_TEST_MODE === "1";
}

function testEnv(name: string): string | undefined {
  return isTestMode() ? process.env[name] : undefined;
}

function formatCommand(command: UpdateCommand): string {
  return [command.executable, ...command.args].join(" ");
}

function globalUpdateCommand(manager: PackageManager): UpdateCommand {
  if (manager === "npm") return { executable: "npm", args: ["install", "-g", `${PACKAGE_NAME}@latest`] };
  if (manager === "pnpm") return { executable: "pnpm", args: ["add", "-g", `${PACKAGE_NAME}@latest`] };
  if (manager === "yarn") return { executable: "yarn", args: ["global", "add", `${PACKAGE_NAME}@latest`] };
  return { executable: "bun", args: ["add", "-g", `${PACKAGE_NAME}@latest`] };
}

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

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function runtimePlatform(): NodeJS.Platform {
  const mocked = testEnv("OMS_TEST_PLATFORM");
  return mocked === "win32" ? "win32" : process.platform;
}

function binaryPathNames(name: string): string[] {
  if (runtimePlatform() !== "win32") return [name];
  const extensions = new Set([...(process.env.PATHEXT ?? "").split(";"), ".cmd", ".ps1", ".exe", ".bat"]);
  const names = [name];
  for (const ext of extensions) {
    if (!ext) continue;
    const normalizedExt = ext.startsWith(".") ? ext : `.${ext}`;
    names.push(`${name}${normalizedExt.toLowerCase()}`, `${name}${normalizedExt}`);
  }
  return [...new Set(names)];
}

function resolvePathBinary(name: string): string | null {
  const mocked = testEnv("OMS_TEST_PATH_BIN");
  if (mocked !== undefined) return mocked.length > 0 ? mocked : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const candidateName of binaryPathNames(name)) {
      const candidate = join(dir, candidateName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findPackageRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    const pkgPath = join(current, "package.json");
    if (existsSync(pkgPath)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readPackageName(root: string): string | null {
  try {
    return readJson<{ name?: string }>(join(root, "package.json"))?.name ?? null;
  } catch {
    return null;
  }
}

function collectRuntimeEvidence(): RuntimeEvidence {
  const mocked = testEnv("OMS_TEST_RUNTIME_EVIDENCE");
  if (mocked !== undefined) return JSON.parse(mocked) as RuntimeEvidence;

  const modulePath = testEnv("OMS_TEST_MODULE_PATH") ?? fileURLToPath(import.meta.url);
  const detectedPackageRoot = findPackageRoot(dirname(modulePath)) ?? packageRoot;
  const mockedArgv1 = testEnv("OMS_TEST_ARGV1");
  const runningBin = mockedArgv1 !== undefined
    ? resolve(mockedArgv1)
    : process.argv[1]
      ? resolve(process.argv[1])
      : modulePath;
  const pathBin = resolvePathBinary("oms");
  return {
    packageRoot: detectedPackageRoot,
    realPackageRoot: safeRealpath(detectedPackageRoot),
    runningBin,
    realRunningBin: safeRealpath(runningBin),
    pathBin,
    realPathBin: pathBin ? safeRealpath(pathBin) : null,
    packageName: readPackageName(detectedPackageRoot),
  };
}

function commandForProject(manager: PackageManager, dev: boolean): string {
  if (manager === "npm") return `npm install ${dev ? "--save-dev " : ""}${PACKAGE_NAME}@latest`;
  if (manager === "pnpm") return `pnpm add ${dev ? "-D " : ""}${PACKAGE_NAME}@latest`;
  if (manager === "yarn") return `yarn add ${dev ? "--dev " : ""}${PACKAGE_NAME}@latest`;
  return `bun add ${dev ? "-d " : ""}${PACKAGE_NAME}@latest`;
}

function nearestProjectRoot(start: string): string | null {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function inferProjectManager(projectRoot: string, pkg: { packageManager?: string }): PackageManager {
  const declared = pkg.packageManager?.split("@")[0];
  if (declared === "pnpm" || declared === "yarn" || declared === "bun" || declared === "npm") return declared;
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(projectRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(projectRoot, "bun.lockb")) || existsSync(join(projectRoot, "bun.lock"))) return "bun";
  return "npm";
}

function projectGuidance(packageRootPath: string): string[] {
  const projectRoot = nearestProjectRoot(dirname(packageRootPath));
  if (!projectRoot) return [`npm install --save-dev ${PACKAGE_NAME}@latest`];
  const pkg = readJson<{
    packageManager?: string;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  }>(join(projectRoot, "package.json"));
  if (!pkg) return [`npm install --save-dev ${PACKAGE_NAME}@latest`];
  const manager = inferProjectManager(projectRoot, pkg);
  const dev = !(pkg.dependencies && PACKAGE_NAME in pkg.dependencies);
  return [commandForProject(manager, dev)];
}

function pathParts(path: string): string[] {
  return normalizePath(safeRealpath(path)).split("/").filter(Boolean);
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isPackageRootNamed(packageRootPath: string): boolean {
  return pathParts(packageRootPath).at(-1) === PACKAGE_NAME;
}

function hasBinPath(binPaths: string[], expectedPaths: string[]): boolean {
  const normalizeForComparison = (path: string) => {
    const normalized = normalizePath(path);
    return runtimePlatform() === "win32" ? normalized.toLowerCase() : normalized;
  };
  const actual = binPaths.map(normalizeForComparison);
  return expectedPaths.some((expected) => actual.includes(normalizeForComparison(expected)));
}

function commandShimPaths(prefix: string, name: string): string[] {
  return [`${prefix}/${name}`, `${prefix}/${name}.cmd`, `${prefix}/${name}.ps1`];
}

function isNpmGlobalLayout(packageRootPath: string, binPaths: string[]): boolean {
  const root = normalizePath(packageRootPath);
  if (root.endsWith(`/lib/node_modules/${PACKAGE_NAME}`)) {
    const prefix = root.slice(0, -`/lib/node_modules/${PACKAGE_NAME}`.length);
    return hasBinPath(binPaths, commandShimPaths(`${prefix}/bin`, "oms"));
  }
  if (root.endsWith(`/node_modules/${PACKAGE_NAME}`)) {
    const prefix = root.slice(0, -`/node_modules/${PACKAGE_NAME}`.length);
    return hasBinPath(binPaths, commandShimPaths(prefix, "oms"));
  }
  return false;
}

function isPnpmGlobalLayout(packageRootPath: string, binPaths: string[]): boolean {
  const root = normalizePath(packageRootPath);
  const suffix = `/node_modules/${PACKAGE_NAME}`;
  const marker = "/global/";
  const markerIndex = root.lastIndexOf(marker);
  if (markerIndex === -1 || !root.endsWith(suffix)) return false;
  const storeVersion = root.slice(markerIndex + marker.length, -suffix.length);
  if (!/^\d+$/.test(storeVersion)) return false;
  const prefix = root.slice(0, markerIndex);
  return hasBinPath(binPaths, [...commandShimPaths(prefix, "oms"), ...commandShimPaths(`${prefix}/bin`, "oms")]);
}

function isYarnGlobalLayout(packageRootPath: string, binPaths: string[]): boolean {
  const root = normalizePath(packageRootPath);
  const suffix = `/.config/yarn/global/node_modules/${PACKAGE_NAME}`;
  if (!root.endsWith(suffix)) return false;
  const home = root.slice(0, -suffix.length);
  return hasBinPath(binPaths, commandShimPaths(`${home}/.yarn/bin`, "oms"));
}

function isBunGlobalLayout(packageRootPath: string, binPaths: string[]): boolean {
  const root = normalizePath(packageRootPath);
  const suffix = `/.bun/install/global/node_modules/${PACKAGE_NAME}`;
  if (!root.endsWith(suffix)) return false;
  const home = root.slice(0, -suffix.length);
  return hasBinPath(binPaths, commandShimPaths(`${home}/.bun/bin`, "oms"));
}

function isProjectLocalLayout(evidence: RuntimeEvidence): boolean {
  const projectRoot = nearestProjectRoot(dirname(evidence.realPackageRoot));
  if (!projectRoot) return false;
  const root = normalizePath(evidence.realPackageRoot);
  const project = normalizePath(projectRoot);
  if (!root.startsWith(`${project}/`)) return false;
  const binPaths = [evidence.pathBin, evidence.runningBin, evidence.realPathBin, evidence.realRunningBin]
    .filter((path): path is string => Boolean(path))
    .map(normalizePath);
  return hasBinPath(binPaths, commandShimPaths(`${project}/node_modules/.bin`, "oms"));
}

function globalManagerFromPaths(evidence: RuntimeEvidence): PackageManager | null {
  const root = normalizePath(evidence.realPackageRoot);
  const binPaths = [evidence.pathBin, evidence.runningBin, evidence.realPathBin, evidence.realRunningBin]
    .filter((path): path is string => Boolean(path))
    .map(normalizePath);
  const managers = new Set<PackageManager>();

  if (isNpmGlobalLayout(root, binPaths)) managers.add("npm");
  if (isPnpmGlobalLayout(root, binPaths)) managers.add("pnpm");
  if (isYarnGlobalLayout(root, binPaths)) managers.add("yarn");
  if (isBunGlobalLayout(root, binPaths)) managers.add("bun");

  return managers.size === 1 ? [...managers][0] : null;
}

function detectInstallContext(): InstallContext {
  const mocked = testEnv("OMS_TEST_INSTALL_CONTEXT");
  if (mocked !== undefined) return JSON.parse(mocked) as InstallContext;

  const evidence = collectRuntimeEvidence();
  const warnings: string[] = [];
  if (evidence.packageName !== PACKAGE_NAME) {
    return {
      kind: "unknown",
      label: `unknown install (package root is not ${PACKAGE_NAME})`,
      guidance: [`npm install -g ${PACKAGE_NAME}@latest`, `pnpm add -g ${PACKAGE_NAME}@latest`],
      warnings,
    };
  }

  if (evidence.realPathBin && evidence.realPathBin !== evidence.realRunningBin) {
    warnings.push(`PATH-resolved oms differs from the running executable: ${evidence.pathBin}`);
  }

  const rootParts = pathParts(evidence.realPackageRoot);
  if (rootParts.includes("_npx") || rootParts.includes("dlx") || rootParts.includes("bunx")) {
    return {
      kind: "ephemeral",
      label: "temporary runner install",
      guidance: [`Run ${PACKAGE_NAME} with @latest, or install it globally with npm install -g ${PACKAGE_NAME}@latest.`],
      warnings,
    };
  }

  if (existsSync(join(evidence.packageRoot, "scripts", "oms.ts")) || existsSync(join(evidence.packageRoot, "tsconfig.json"))) {
    return {
      kind: "development",
      label: "development checkout",
      guidance: ["Update the source checkout with git, then rebuild."],
      warnings,
    };
  }

  if (normalizePath(evidence.realPackageRoot).includes(`/node_modules/${PACKAGE_NAME}`)) {
    const manager = globalManagerFromPaths(evidence);
    if (manager && isPackageRootNamed(evidence.realPackageRoot)) {
      const updateCommand = globalUpdateCommand(manager);
      return {
        kind: "global",
        label: `global ${manager} install`,
        manager,
        updateCommand,
        guidance: [formatCommand(updateCommand)],
        warnings,
      };
    }
    if (!isProjectLocalLayout(evidence)) {
      return {
        kind: "unknown",
        label: "unknown install context",
        guidance: [`npm install -g ${PACKAGE_NAME}@latest`, `pnpm add -g ${PACKAGE_NAME}@latest`],
        warnings,
      };
    }
    return {
      kind: "project",
      label: "project-local install",
      guidance: projectGuidance(evidence.realPackageRoot),
      warnings,
    };
  }

  return {
    kind: "unknown",
    label: "unknown install context",
    guidance: [`npm install -g ${PACKAGE_NAME}@latest`, `pnpm add -g ${PACKAGE_NAME}@latest`],
    warnings,
  };
}

function validateSources(data: unknown): Repo[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`${MANIFEST_FILENAME}: root must be a mapping`);
  }
  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      throw new Error(`${MANIFEST_FILENAME}: unknown top-level key "${key}"`);
    }
  }
  const { repos } = obj;
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

  return validated;
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - s.length));
}

/** Names of a repo's non-origin remotes, in declared order (origin is shown via its URL column). */
function extraRemoteNames(repo: Repo): string[] {
  return Object.keys(repo.remotes).filter((name) => name !== "origin");
}

function printList(repos: Repo[]): void {
  const extras = (r: Repo) => {
    const names = extraRemoteNames(r);
    return names.length > 0 ? ` (+${names.join(",")})` : "";
  };
  const aliasW = Math.max("ALIAS".length, ...repos.map((r) => r.alias.length));
  const urlW = Math.max(
    "ORIGIN".length,
    ...repos.map((r) => (r.remotes.origin + extras(r)).length),
  );
  console.log(dim(`${pad("ALIAS", aliasW)}  ${pad("ORIGIN", urlW)}  BRANCH`));
  for (const r of repos) {
    console.log(`${pad(r.alias, aliasW)}  ${pad(r.remotes.origin + extras(r), urlW)}  ${r.branch ?? ""}`);
  }
}

async function selectInteractive(repos: Repo[], actionLabel: string): Promise<Repo[] | null> {
  const choice = await multiselect({
    message: `Select source repos to ${actionLabel} (space to toggle, enter to confirm)`,
    options: repos.map((r) => ({
      value: r.alias,
      label: r.alias,
      hint: r.branch ? `branch: ${r.branch}` : undefined,
    })),
    required: true,
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return choice
    .map((alias) => repos.find((r) => r.alias === alias))
    .filter((r): r is Repo => r !== undefined);
}

/**
 * Resolve a single alias for a per-repo branch command (switch/checkout). An explicit alias is
 * validated and must be a synced submodule; when omitted, the user picks one interactively from the
 * synced submodules. Returns null (with a clear message) on an unknown/unsynced alias, an empty set,
 * a non-interactive shell, or cancellation.
 */
async function resolveInitializedAlias(
  repos: Repo[],
  repoRoot: string,
  alias: string | undefined,
  actionLabel: string,
): Promise<Repo | null> {
  if (alias) {
    const repo = repos.find((r) => r.alias === alias);
    if (!repo) {
      log.error(`Unknown alias "${alias}". Use "oms sync --list" to see registered aliases.`);
      return null;
    }
    if (!submoduleInitialized(repoRoot, alias)) {
      log.error(`${alias}: not synced. Run "oms sync ${alias}" first.`);
      return null;
    }
    return repo;
  }

  const initialized = repos.filter((r) => submoduleInitialized(repoRoot, r.alias));
  if (initialized.length === 0) {
    log.error(`No synced submodules to ${actionLabel}. Run "oms sync" first.`);
    return null;
  }
  if (!process.stdin.isTTY) {
    log.error(`No alias given and stdin is not a TTY. Pass an alias: "oms ${actionLabel} <alias>".`);
    return null;
  }
  const choice = await select({
    message: `Select a source repo to ${actionLabel}`,
    options: initialized.map((r) => ({
      value: r.alias,
      label: r.alias,
      hint: r.branch ? `branch: ${r.branch}` : undefined,
    })),
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return initialized.find((r) => r.alias === (choice as string)) ?? null;
}

/** Sentinel chosen in pickBranch to create a new branch instead of selecting an existing one. */
const CREATE_NEW_BRANCH = "\0create-new-branch";

/**
 * Prompt for a branch from the given list. When allowCreate is set, a "create new branch" option
 * collects a name via a text prompt. Returns null (with a clear message) on a non-interactive shell,
 * an empty list with no create option, an empty name, or cancellation.
 */
async function pickBranch(
  branches: string[],
  message: string,
  allowCreate: boolean,
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    log.error(`No branch given and stdin is not a TTY. Pass a branch name explicitly.`);
    return null;
  }
  if (branches.length === 0 && !allowCreate) {
    log.error(`No branches available to select.`);
    return null;
  }
  const options = [
    ...(allowCreate ? [{ value: CREATE_NEW_BRANCH, label: "+ create new branch" }] : []),
    ...branches.map((b) => ({ value: b, label: b })),
  ];
  const choice = await select({ message, options });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  if (choice === CREATE_NEW_BRANCH) {
    const name = await text({ message: "New branch name", placeholder: "feature/login" });
    if (isCancel(name)) {
      cancel("Cancelled.");
      return null;
    }
    const trimmed = (name as string).trim();
    if (!trimmed) {
      log.error("Branch name is empty.");
      return null;
    }
    return trimmed;
  }
  return choice as string;
}

/**
 * Decide which remote(s) a fetch/pull/push targets for one repo. Honors an explicit --remote list,
 * otherwise prompts interactively on a TTY (origin preselected) and falls back to origin off-TTY.
 * pull is restricted to a single remote since --ff-only can advance to at most one. Returns the
 * resolved remote names, or null when the request is invalid or the prompt was cancelled.
 */
async function resolveRemotes(
  repo: Repo,
  requested: string[] | undefined,
  command: ManageCommand,
): Promise<string[] | null> {
  const declared = Object.keys(repo.remotes);

  if (requested && requested.length > 0) {
    const unique = uniqueAliases(requested);
    const unknown = unique.filter((name) => !declared.includes(name));
    if (unknown.length > 0) {
      log.error(
        `${repo.alias}: unknown remote(s): ${unknown.join(", ")}. Declared: ${declared.join(", ")}.`,
      );
      return null;
    }
    if (command === "pull" && unique.length > 1) {
      log.error(`${repo.alias}: pull targets a single remote (git pull --ff-only can advance only one).`);
      return null;
    }
    return unique;
  }

  // No explicit remote: a lone origin needs no prompt, and a non-interactive shell defaults to origin.
  if (declared.length === 1) return declared;
  if (!process.stdin.isTTY) return ["origin"];

  if (command === "pull") {
    const choice = await select({
      message: `${repo.alias}: select a remote to ${command}`,
      options: declared.map((name) => ({ value: name, label: name, hint: repo.remotes[name] })),
      initialValue: "origin",
    });
    if (isCancel(choice)) {
      cancel("Cancelled.");
      return null;
    }
    return [choice as string];
  }

  const choice = await multiselect({
    message: `${repo.alias}: select remote(s) to ${command} (space to toggle, enter to confirm)`,
    options: declared.map((name) => ({ value: name, label: name, hint: repo.remotes[name] })),
    initialValues: ["origin"],
    required: true,
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return choice as string[];
}

function runGit(cwd: string, args: string[], inheritOutput = false): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: inheritOutput ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  return {
    exitCode: result.status,
    success: result.status === 0,
    stdout: inheritOutput ? "" : (result.stdout ?? ""),
  };
}

/** Run git inside the submodule working tree at oms/<alias>/. */
function runSub(repoRoot: string, alias: string, args: string[], inheritOutput = false): GitResult {
  return runGit(aliasDir(repoRoot, alias), args, inheritOutput);
}

function parseGitVersion(s: string): { major: number; minor: number } | null {
  const m = s.match(/git version (\d+)\.(\d+)/);
  if (!m) return null;
  return { major: Number.parseInt(m[1], 10), minor: Number.parseInt(m[2], 10) };
}

function isGitVersionSupported(v: { major: number; minor: number }): boolean {
  if (v.major > MIN_GIT_MAJOR) return true;
  if (v.major < MIN_GIT_MAJOR) return false;
  return v.minor >= MIN_GIT_MINOR;
}

function findWorkspaceRoot(options: WorkspaceOptions = {}): string | null {
  let current = resolve(options.cwd ?? process.cwd());
  while (true) {
    if (existsSync(join(current, MANIFEST_FILENAME))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function aliasDir(repoRoot: string, alias: string): string {
  return join(repoRoot, DATA_DIRNAME, alias);
}

/** Submodule name and path are identical under our convention: oms/<alias>. */
function submodulePath(alias: string): string {
  return `${DATA_DIRNAME}/${alias}`;
}

function isGitRepo(repoRoot: string): boolean {
  return runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() === "true";
}

/** Every submodule path registered in .gitmodules (empty when the file is absent or registers none). */
function registeredSubmodulePaths(repoRoot: string): string[] {
  if (!existsSync(join(repoRoot, ".gitmodules"))) return [];

  const result = runGit(repoRoot, [
    "config",
    "--file",
    ".gitmodules",
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ]);
  if (!result.success) return [];

  return result.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((p): p is string => Boolean(p));
}

/** True when .gitmodules registers a submodule at the given path (sources/<alias> or oms/<alias>). */
function isRegisteredSubmodule(repoRoot: string, sourcePath: string): boolean {
  return registeredSubmodulePaths(repoRoot).includes(sourcePath);
}

/** True when .gitmodules still registers at least one submodule. */
function hasRegisteredSubmodules(repoRoot: string): boolean {
  return registeredSubmodulePaths(repoRoot).length > 0;
}

/** A submodule is initialized when its working tree has a .git gitlink file/dir. */
function submoduleInitialized(repoRoot: string, alias: string): boolean {
  return existsSync(join(aliasDir(repoRoot, alias), ".git"));
}

/** Short branch name, or null when HEAD is detached. */
function currentBranch(dir: string): string | null {
  const r = runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.success) return null;
  const b = r.stdout.trim();
  return b && b !== "HEAD" ? b : null;
}

function shortSha(dir: string): string {
  const r = runGit(dir, ["rev-parse", "--short", "HEAD"]);
  return r.success ? r.stdout.trim() : "???????";
}

function localBranchExists(dir: string, branch: string): boolean {
  return runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).success;
}

function remoteBranchExists(dir: string, branch: string): boolean {
  return runGit(dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]).success;
}

/** Local branch short names (refs/heads), e.g. ["main", "dev"]. Empty on failure or none. */
function listLocalBranches(dir: string): string[] {
  const r = runGit(dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  if (!r.success) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Remote branch short names under origin, with the "origin/" prefix stripped and origin/HEAD excluded. */
function listRemoteBranches(dir: string): string[] {
  const r = runGit(dir, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
  if (!r.success) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "origin/HEAD")
    .map((s) => (s.startsWith("origin/") ? s.slice("origin/".length) : s))
    .filter((s) => s !== "HEAD");
}

function isDirty(dir: string): boolean {
  const r = runGit(dir, ["status", "--porcelain"]);
  return r.success && r.stdout.trim().length > 0;
}

/** The branch recorded in .gitmodules for the submodule, if any. */
function gitmodulesBranch(repoRoot: string, alias: string): string | null {
  const r = runGit(repoRoot, [
    "config",
    "--file",
    ".gitmodules",
    "--get",
    `submodule.${submodulePath(alias)}.branch`,
  ]);
  if (!r.success) return null;
  const b = r.stdout.trim();
  return b.length > 0 ? b : null;
}

/**
 * Keep the submodule on a branch instead of a detached HEAD. Only acts when HEAD is detached,
 * so a branch the user is already working on is never disturbed. When no local branch exists
 * yet, a branch is created at the current (pinned) commit — the checked-out commit is preserved,
 * which keeps the parent's recorded pointer reproducible.
 */
function attachBranch(repoRoot: string, alias: string, branch: string): void {
  if (currentBranch(aliasDir(repoRoot, alias)) !== null) return;

  if (localBranchExists(aliasDir(repoRoot, alias), branch)) {
    runSub(repoRoot, alias, ["switch", branch]);
    return;
  }
  // Create the branch at the current HEAD (the pinned commit) so the worktree stays put.
  if (!runSub(repoRoot, alias, ["switch", "-c", branch]).success) return;
  if (remoteBranchExists(aliasDir(repoRoot, alias), branch)) {
    runSub(repoRoot, alias, ["branch", "--set-upstream-to", `origin/${branch}`, branch]);
  }
}

/**
 * Reconcile the submodule's git remotes with the declared `remotes` map: add missing remotes and
 * update URLs that drifted. Non-destructive — remotes no longer in oms.yaml are left untouched.
 */
function ensureRemotes(repoRoot: string, alias: string, remotes: Record<string, string>): void {
  for (const [name, url] of Object.entries(remotes)) {
    const existing = runSub(repoRoot, alias, ["remote", "get-url", name]);
    if (!existing.success) {
      runSub(repoRoot, alias, ["remote", "add", name, url]);
    } else if (existing.stdout.trim() !== url) {
      runSub(repoRoot, alias, ["remote", "set-url", name, url]);
    }
  }
}

function emitLegacyRenameMessage(dir: string, found: { manifest: boolean; data: boolean }): void {
  const artifacts = [
    found.manifest ? `'${LEGACY_MANIFEST}'` : null,
    found.data ? `'${LEGACY_DATA_DIRNAME}/'` : null,
  ]
    .filter((s): s is string => s !== null)
    .join(" and ");
  log.error(
    `detected legacy ${artifacts} at ${dir}.\n` +
      `  oh-my-space 0.4.0 renamed the manifest to ${MANIFEST_FILENAME} and the data directory to ${DATA_DIRNAME}/.\n` +
      `  See ${docUrl(RENAME_MIGRATION_DOC)} for the manual steps. Aborting to avoid destructive change.`,
  );
}

/** Block when the active oms.yaml workspace still has 0.3.x rename artifacts at its root. */
function abortOnLegacyRenameAt(repoRoot: string): boolean {
  const manifest = existsSync(join(repoRoot, LEGACY_MANIFEST));
  const data = existsSync(join(repoRoot, LEGACY_DATA_DIRNAME));
  if (!manifest && !data) return false;
  emitLegacyRenameMessage(repoRoot, { manifest, data });
  return true;
}

/**
 * When oms.yaml could not be found, walk upward looking for a 0.3.x manifest (sources.yaml).
 * Only the manifest is trusted as a positive signal — a stray sources/ directory by itself
 * could belong to an unrelated tool. Returns true if a hint was emitted.
 */
function emitLegacyRenameHintWalkUp(options: WorkspaceOptions = {}): boolean {
  let current = resolve(options.cwd ?? process.cwd());
  while (true) {
    if (existsSync(join(current, LEGACY_MANIFEST))) {
      emitLegacyRenameMessage(current, {
        manifest: true,
        data: existsSync(join(current, LEGACY_DATA_DIRNAME)),
      });
      return true;
    }
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Detect leftover 0.3.x–0.5.x bare clone + worktree artifacts (oms/<alias>/.bare). */
function abortOnLegacyWorktree(repoRoot: string, repos: Repo[]): boolean {
  const stale = repos.find((repo) => existsSync(join(aliasDir(repoRoot, repo.alias), ".bare")));
  if (!stale) return false;
  log.error(
    `detected a legacy bare clone at ${DATA_DIRNAME}/${stale.alias}/.bare. oh-my-space 0.6.0 manages sources as git submodules.\n` +
      `  See ${docUrl(WORKTREE_MIGRATION_DOC)} for the manual steps. Aborting to avoid destructive change.`,
  );
  return true;
}

/** Submodules live inside the parent's history, so oms/ must not be gitignored. Strip a managed entry. */
function ensureOmsNotIgnored(repoRoot: string): void {
  const path = join(repoRoot, ".gitignore");
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split("\n");
  const out: string[] = [];
  let removed = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === GITIGNORE_ENTRY || trimmed === `/${GITIGNORE_ENTRY}`) {
      if (out.length > 0 && out[out.length - 1].trim() === GITIGNORE_COMMENT) out.pop();
      removed = true;
      continue;
    }
    out.push(line);
  }
  if (removed) {
    writeFileSync(path, out.join("\n"));
    log.info(`removed ${GITIGNORE_ENTRY} from .gitignore (submodules are tracked, not ignored)`);
  }
}

function gitignoreIgnoresOms(repoRoot: string): boolean {
  const gi = join(repoRoot, ".gitignore");
  return (
    existsSync(gi)
    && readFileSync(gi, "utf8")
      .split("\n")
      .some((l) => l.trim() === GITIGNORE_ENTRY || l.trim() === `/${GITIGNORE_ENTRY}`)
  );
}

function cleanupFailedAdd(repoRoot: string, alias: string): void {
  const path = submodulePath(alias);
  runGit(repoRoot, ["submodule", "deinit", "-f", "--", path]);
  runGit(repoRoot, ["rm", "-f", "--cached", "--", path]);
  runGit(repoRoot, ["config", "--file", ".gitmodules", "--remove-section", `submodule.${path}`]);
  if (existsSync(join(repoRoot, ".gitmodules"))) runGit(repoRoot, ["add", ".gitmodules"]);
  try {
    rmSync(join(repoRoot, ".git", "modules", DATA_DIRNAME, alias), { recursive: true, force: true });
  } catch {}
  try {
    if (existsSync(aliasDir(repoRoot, alias))) rmSync(aliasDir(repoRoot, alias), { recursive: true, force: true });
  } catch {}
}

function syncRepo(repo: Repo, repoRoot: string): OperationResult {
  const alias = repo.alias;
  const path = submodulePath(alias);
  const registered = isRegisteredSubmodule(repoRoot, path);

  if (!registered) {
    if (existsSync(aliasDir(repoRoot, alias)) && readdirSync(aliasDir(repoRoot, alias)).length > 0) {
      log.error(
        `${alias}: ${path}/ already exists but is not a registered submodule. Move or remove it manually, then retry.`,
      );
      return "failed";
    }

    if (repo.branch) {
      const lsRemote = runGit(repoRoot, [
        "ls-remote",
        "--exit-code",
        "--heads",
        repo.remotes.origin,
        repo.branch,
      ]);
      if (lsRemote.exitCode === 2) {
        log.error(
          `${alias}: branch "${repo.branch}" not found on ${repo.remotes.origin}. Push the branch upstream or fix the alias, then retry.`,
        );
        return "failed";
      }
      if (!lsRemote.success && lsRemote.exitCode !== 2) {
        log.warn(`${alias}: branch existence check failed (exit ${lsRemote.exitCode}); proceeding.`);
      }
    }

    // `git submodule add` refuses when .gitmodules is tracked in HEAD but missing from the
    // working tree — the state left by an uncommitted unsync. Restore an empty one so it can append.
    const gitmodules = join(repoRoot, ".gitmodules");
    if (!existsSync(gitmodules) && runGit(repoRoot, ["cat-file", "-e", "HEAD:.gitmodules"]).success) {
      writeFileSync(gitmodules, "");
    }

    log.step(`${alias}: git submodule add${repo.branch ? ` -b ${repo.branch}` : ""} ${repo.remotes.origin} ${path}`);
    const args = ["submodule", "add", ...(repo.branch ? ["-b", repo.branch] : []), "--", repo.remotes.origin, path];
    const add = runGit(repoRoot, args, true);
    if (!add.success) {
      log.error(`${alias}: git submodule add failed (exit ${add.exitCode})`);
      cleanupFailedAdd(repoRoot, alias);
      return "failed";
    }
    ensureRemotes(repoRoot, alias, repo.remotes);
    const branch = repo.branch ?? currentBranch(aliasDir(repoRoot, alias));
    if (branch) attachBranch(repoRoot, alias, branch);
    log.success(`${alias}: added${branch ? ` (branch=${branch})` : ""}`);
    return "added";
  }

  if (!submoduleInitialized(repoRoot, alias)) {
    log.step(`${alias}: git submodule update --init ${path}`);
    const upd = runGit(repoRoot, ["submodule", "update", "--init", "--", path], true);
    if (!upd.success) {
      log.error(`${alias}: git submodule update --init failed (exit ${upd.exitCode})`);
      return "failed";
    }
    ensureRemotes(repoRoot, alias, repo.remotes);
    const branch = gitmodulesBranch(repoRoot, alias) ?? repo.branch;
    if (branch) attachBranch(repoRoot, alias, branch);
    log.success(`${alias}: initialized${branch ? ` (branch=${branch})` : ""}`);
    return "added";
  }

  ensureRemotes(repoRoot, alias, repo.remotes);
  log.step(`${alias}: git fetch origin --prune`);
  const fetch = runSub(repoRoot, alias, ["fetch", "origin", "--prune"], true);
  if (!fetch.success) {
    log.error(`${alias}: fetch failed (exit ${fetch.exitCode})`);
    return "failed";
  }
  const branch = gitmodulesBranch(repoRoot, alias) ?? repo.branch;
  if (branch) attachBranch(repoRoot, alias, branch);
  log.success(`${alias}: updated`);
  return "updated";
}

function unsyncRepo(repo: Repo, repoRoot: string, force: boolean): RemoveOutcome {
  const alias = repo.alias;
  const path = submodulePath(alias);
  const registered = isRegisteredSubmodule(repoRoot, path);
  const exists = existsSync(aliasDir(repoRoot, alias));

  if (!registered && !exists) return "nothing-to-remove";

  if (!force && submoduleInitialized(repoRoot, alias) && isDirty(aliasDir(repoRoot, alias))) {
    log.error(
      `${alias}: ${path} has uncommitted or untracked changes. Commit, stash, remove them, or pass --force.`,
    );
    return "failed";
  }

  runGit(repoRoot, ["submodule", "deinit", ...(force ? ["-f"] : []), "--", path]);
  const rm = runGit(repoRoot, ["rm", "-f", "--", path], true);
  if (!rm.success) {
    // git rm couldn't stage the removal (e.g. the submodule was never initialized).
    runGit(repoRoot, ["rm", "-f", "--cached", "--", path]);
  }
  // Always strip the registration explicitly: git rm's implicit .gitmodules edit is unreliable
  // across git versions/states, and when it silently no-ops the section is orphaned for good.
  // A missing section just makes these exit non-zero — harmless, output stays captured.
  runGit(repoRoot, ["config", "--file", ".gitmodules", "--remove-section", `submodule.${path}`]);
  if (existsSync(join(repoRoot, ".gitmodules"))) runGit(repoRoot, ["add", ".gitmodules"]);
  // Drop the matching .git/config section too, in case deinit was skipped or failed.
  runGit(repoRoot, ["config", "--remove-section", `submodule.${path}`]);
  try {
    rmSync(join(repoRoot, ".git", "modules", DATA_DIRNAME, alias), { recursive: true, force: true });
  } catch {}
  // Drop the now-empty .git/modules/oms/ container so no stale gitdir scaffolding lingers.
  try {
    const modulesParent = join(repoRoot, ".git", "modules", DATA_DIRNAME);
    if (existsSync(modulesParent) && readdirSync(modulesParent).length === 0) rmdirSync(modulesParent);
  } catch {}
  if (existsSync(aliasDir(repoRoot, alias))) {
    rmSync(aliasDir(repoRoot, alias), { recursive: true, force: true });
  }
  // Drop the now-empty oms/ directory if nothing else lives there.
  try {
    const parent = join(repoRoot, DATA_DIRNAME);
    if (existsSync(parent) && readdirSync(parent).length === 0) rmdirSync(parent);
  } catch {}

  // Drop .gitmodules once it no longer registers any submodule (judged by content, not byte-emptiness).
  const gitmodules = join(repoRoot, ".gitmodules");
  if (existsSync(gitmodules) && !hasRegisteredSubmodules(repoRoot)) {
    if (!runGit(repoRoot, ["rm", "-f", "--", ".gitmodules"]).success) {
      rmSync(gitmodules, { force: true });
    }
  }

  return "removed";
}

function fetchRepo(repo: Repo, repoRoot: string, remotes: string[]): OperationResult {
  if (!submoduleInitialized(repoRoot, repo.alias)) {
    log.error(`${repo.alias}: not synced. Run "oms sync ${repo.alias}" first.`);
    return "failed";
  }
  for (const remote of remotes) {
    log.step(`${repo.alias}: git fetch ${remote} --prune`);
    const r = runSub(repoRoot, repo.alias, ["fetch", remote, "--prune"], true);
    if (!r.success) {
      log.error(`${repo.alias}: fetch ${remote} failed (exit ${r.exitCode})`);
      return "failed";
    }
  }
  log.success(`${repo.alias}: fetched (${remotes.join(", ")})`);
  return "fetched";
}

function pullRepo(repo: Repo, repoRoot: string, remote: string): OperationResult {
  if (!submoduleInitialized(repoRoot, repo.alias)) {
    log.error(`${repo.alias}: not synced. Run "oms sync ${repo.alias}" first.`);
    return "failed";
  }
  const branch = currentBranch(aliasDir(repoRoot, repo.alias));
  if (!branch) {
    log.error(
      `${repo.alias}: detached HEAD. Run "oms switch ${repo.alias} <branch>" before pulling.`,
    );
    return "failed";
  }
  if (isDirty(aliasDir(repoRoot, repo.alias))) {
    log.error(
      `${repo.alias}: submodule has uncommitted changes. Commit, stash, or clean them inside oms/${repo.alias} before pulling.`,
    );
    return "failed";
  }
  log.step(`${repo.alias}/${branch}: git pull --ff-only ${remote} ${branch}`);
  const r = runSub(repoRoot, repo.alias, ["pull", "--ff-only", remote, branch], true);
  if (!r.success) {
    log.error(`${repo.alias}/${branch}: pull from ${remote} failed (exit ${r.exitCode})`);
    return "failed";
  }
  // Pull synchronizes only the submodule branch; the root gitlink is never staged or committed.
  log.success(`${repo.alias}/${branch}: pulled from ${remote}`);
  printRootFollowup(repoRoot, repo.alias);
  return "pulled";
}

function pushRepo(repo: Repo, repoRoot: string, remotes: string[]): OperationResult {
  if (!submoduleInitialized(repoRoot, repo.alias)) {
    log.error(`${repo.alias}: not synced. Run "oms sync ${repo.alias}" first.`);
    return "failed";
  }
  const branch = currentBranch(aliasDir(repoRoot, repo.alias));
  if (!branch) {
    log.error(
      `${repo.alias}: detached HEAD. Run "oms switch ${repo.alias} <branch>" before pushing.`,
    );
    return "failed";
  }
  if (isDirty(aliasDir(repoRoot, repo.alias))) {
    log.warn(`${repo.alias}: submodule has uncommitted changes; only the current HEAD will be pushed.`);
  }
  for (const remote of remotes) {
    // Only origin sets upstream — repointing @{u} to a fork would skew "oms status" ahead/behind.
    const args = remote === "origin" ? ["push", "-u", "origin", branch] : ["push", remote, branch];
    log.step(`${repo.alias}/${branch}: git ${args.join(" ")}`);
    const r = runSub(repoRoot, repo.alias, args, true);
    if (!r.success) {
      log.error(`${repo.alias}/${branch}: push to ${remote} failed (exit ${r.exitCode})`);
      return "failed";
    }
  }
  // Push synchronizes only the submodule branch; the root gitlink is never staged or committed.
  log.success(`${repo.alias}/${branch}: pushed to ${remotes.join(", ")}`);
  printRootFollowup(repoRoot, repo.alias);
  return "pushed";
}

function printSummary(results: OperationResult[]): void {
  const counts: Record<OperationResult, number> = {
    added: 0,
    updated: 0,
    fetched: 0,
    pulled: 0,
    pushed: 0,
    unsynced: 0,
    failed: 0,
  };
  for (const r of results) counts[r]++;

  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${name} ${count}`);
  log.message(`Summary: ${parts.join(", ")}`);
}

function exitFromResults(results: OperationResult[]): number {
  return results.includes("failed") ? 2 : 0;
}

function loadRepos(options: WorkspaceOptions = {}): { repos: Repo[]; repoRoot: string } | null {
  const repoRoot = findWorkspaceRoot(options);
  if (!repoRoot) {
    log.error(
      `Could not find ${MANIFEST_FILENAME} in the current directory or its parents. Create a ${MANIFEST_FILENAME} in this project, then retry.`,
    );
    return null;
  }

  try {
    const manifestPath = join(repoRoot, MANIFEST_FILENAME);
    return { repos: validateSources(parseYaml(readFileSync(manifestPath, "utf8"))), repoRoot };
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Shared preamble: load manifest, emit legacy hints, and confirm the workspace is a git repo. */
function loadForSubmodules(): { repos: Repo[]; repoRoot: string } | null {
  const loaded = loadRepos();
  if (!loaded) {
    emitLegacyRenameHintWalkUp();
    return null;
  }
  const { repoRoot, repos } = loaded;
  if (abortOnLegacyRenameAt(repoRoot)) return null;
  if (!isGitRepo(repoRoot)) {
    log.error(
      `${repoRoot} is not a git repository. oh-my-space 0.6.0 manages sources as git submodules; run "git init" at the workspace root first.`,
    );
    return null;
  }
  if (abortOnLegacyWorktree(repoRoot, repos)) return null;
  return loaded;
}

function uniqueAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  return aliases.filter((alias) => {
    if (seen.has(alias)) return false;
    seen.add(alias);
    return true;
  });
}

async function selectRepos(
  repos: Repo[],
  aliases: string[],
  options: SourcesOptions,
  actionLabel: string,
): Promise<Repo[] | null> {
  if (options.all) return repos;

  if (aliases.length === 0) {
    return selectInteractive(repos, actionLabel);
  }

  const unknown = aliases.filter((a) => !repos.some((r) => r.alias === a));
  if (unknown.length > 0) {
    log.error(
      `Unknown alias(es): ${unknown.join(", ")}. Use "oms sync --list" to see available aliases.`,
    );
    return null;
  }

  const byAlias = new Map(repos.map((repo) => [repo.alias, repo]));
  return uniqueAliases(aliases).map((alias) => byAlias.get(alias)!);
}

async function runSync(aliases: string[], options: SyncCommitOptions): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) {
    emitLegacyRenameHintWalkUp();
    return 1;
  }
  const { repos, repoRoot } = loaded;
  if (abortOnLegacyRenameAt(repoRoot)) return 1;

  if (options.list) {
    printList(repos);
    return 0;
  }

  if (!isGitRepo(repoRoot)) {
    log.error(
      `${repoRoot} is not a git repository. oh-my-space 0.6.0 manages sources as git submodules; run "git init" at the workspace root first.`,
    );
    return 1;
  }
  if (abortOnLegacyWorktree(repoRoot, repos)) return 1;

  const picked = await selectRepos(repos, aliases, options, "sync");
  if (!picked || picked.length === 0) return 1;

  ensureOmsNotIgnored(repoRoot);

  const results = picked.map((repo) => syncRepo(repo, repoRoot));
  const topoExit = await finalizeTopology(
    repoRoot,
    picked.map((r) => r.alias),
    "add",
    options.commit ?? false,
    !results.includes("failed"),
  );
  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results) || topoExit;
}

async function runManage(
  command: ManageCommand,
  aliases: string[],
  options: SourcesOptions & PushOptions & RemoteOptions,
): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  // Reject the removed push pointer shortcuts before any push runs, with migration guidance.
  if (command === "push" && (options.commit || options.record)) {
    const flag = options.record ? "--record" : "--commit";
    const pushExample = aliases.length > 0 ? `oms push ${aliases.join(" ")}` : "oms push <alias>";
    const recordExample = aliases.length > 0 ? `oms record ${aliases[0]}` : "oms record <alias>";
    log.error(
      `"oms push ${flag}" is not supported. Push the submodule branch with "${pushExample}", then commit the existing root pointer update with "${recordExample}".`,
    );
    return 1;
  }

  const picked = await selectRepos(repos, aliases, options, command);
  if (!picked || picked.length === 0) return 1;

  // Each alias is processed independently; a per-alias failure does not stop later aliases.
  const results: OperationResult[] = [];
  for (const repo of picked) {
    const remotes = await resolveRemotes(repo, options.remote, command);
    if (!remotes || remotes.length === 0) {
      results.push("failed");
      continue;
    }
    if (command === "fetch") results.push(fetchRepo(repo, repoRoot, remotes));
    else if (command === "pull") results.push(pullRepo(repo, repoRoot, remotes[0]));
    else results.push(pushRepo(repo, repoRoot, remotes));
  }
  if (results.length > 1 || options.all) printSummary(results);
  return exitFromResults(results);
}

async function runUnsync(aliases: string[], options: UnsyncOptions): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const picked = await selectRepos(repos, aliases, options, "unsync");
  if (!picked || picked.length === 0) return 1;

  const results: OperationResult[] = picked.map((repo) => {
    log.step(`${repo.alias}: unsync`);
    const outcome = unsyncRepo(repo, repoRoot, options.force ?? false);
    if (outcome === "removed") {
      log.success(`${repo.alias}: unsynced`);
      return "unsynced";
    }
    if (outcome === "nothing-to-remove") {
      log.info(`${repo.alias}: nothing to remove`);
      return "unsynced";
    }
    return "failed";
  });

  const topoExit = await finalizeTopology(
    repoRoot,
    picked.map((r) => r.alias),
    "remove",
    options.commit ?? false,
    !results.includes("failed"),
  );

  if (results.length > 1 || options.all) printSummary(results);
  // Name the failed aliases so a buried failure among several isn't read as "all unsynced".
  const failed = picked.filter((_, i) => results[i] === "failed").map((r) => r.alias);
  if (failed.length > 0) {
    log.error(
      `Not unsynced: ${failed.join(", ")}. The submodule had uncommitted or untracked changes — commit/stash/remove them, or re-run with --force.`,
    );
  }
  return exitFromResults(results) || topoExit;
}

/**
 * LOCAL branch management: switch the submodule to an existing local branch or create a new one.
 * No remote is consulted — creating a brand-new branch needs no remote precondition and sets no
 * upstream (that is checkout's job). Omitting alias and/or branch prompts for them interactively.
 */
async function runSwitch(
  alias: string | undefined,
  branch: string | undefined,
  options: CheckoutOptions,
): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const repo = await resolveInitializedAlias(repos, repoRoot, alias, "switch");
  if (!repo) return 1;
  const dir = aliasDir(repoRoot, repo.alias);

  let target = branch;
  if (!target) {
    const picked = await pickBranch(listLocalBranches(dir), `${repo.alias}: select a local branch`, true);
    if (!picked) return 1;
    target = picked;
  }

  if (localBranchExists(dir, target)) {
    log.step(`${repo.alias}: git switch ${target}`);
    const r = runSub(repoRoot, repo.alias, ["switch", target], true);
    if (!r.success) return 2;
    log.success(`${repo.alias}: on ${target}`);
    return 0;
  }

  // Brand-new local branch: no remote precondition, no upstream tracking (use "oms checkout" for that).
  const args = ["switch", "-c", target, ...(options.from ? [options.from] : [])];
  log.step(`${repo.alias}: git ${args.join(" ")}`);
  const r = runSub(repoRoot, repo.alias, args, true);
  if (!r.success) return 2;
  log.success(`${repo.alias}: created new local branch ${target}. Push it with "oms push ${repo.alias}".`);
  return 0;
}

/**
 * REMOTE branch exploration: fetch origin, then check out a remote branch as a local tracking
 * branch (or switch to an existing local counterpart). Omitting alias and/or branch prompts for
 * them interactively. Creating brand-new local branches is "oms switch"'s job.
 */
async function runCheckout(alias: string | undefined, branch: string | undefined): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const repo = await resolveInitializedAlias(repos, repoRoot, alias, "checkout");
  if (!repo) return 1;
  const dir = aliasDir(repoRoot, repo.alias);

  log.step(`${repo.alias}: git fetch origin --prune`);
  const fetch = runSub(repoRoot, repo.alias, ["fetch", "origin", "--prune"], true);
  if (!fetch.success) return 2;

  let target = branch;
  if (!target) {
    const picked = await pickBranch(listRemoteBranches(dir), `${repo.alias}: select a remote branch (origin/*)`, false);
    if (!picked) return 1;
    target = picked;
  }

  if (localBranchExists(dir, target)) {
    log.step(`${repo.alias}: git switch ${target}`);
    const r = runSub(repoRoot, repo.alias, ["switch", target], true);
    if (!r.success) return 2;
    log.success(`${repo.alias}: on ${target}`);
    return 0;
  }
  if (remoteBranchExists(dir, target)) {
    log.step(`${repo.alias}: git switch -c ${target} origin/${target}`);
    const r = runSub(repoRoot, repo.alias, ["switch", "-c", target, `origin/${target}`], true);
    if (!r.success) return 2;
    log.success(`${repo.alias}: on ${target} (tracking origin/${target})`);
    return 0;
  }

  log.error(
    `${repo.alias}: "${target}" not found on origin. To create a new local branch, run "oms switch ${repo.alias} ${target}".`,
  );
  return 1;
}

type StatusRow = {
  alias: string;
  branch: string;
  pin: string;
  dirty: string;
  ahead: string;
  behind: string;
};

/** Parse the leading status char from `git submodule status` (' ' ok, '+' moved, '-' uninit, 'U' conflict). */
function pinState(repoRoot: string, alias: string): string {
  const r = runGit(repoRoot, ["submodule", "status", "--", submodulePath(alias)]);
  if (!r.success || r.stdout.length === 0) return "?";
  const c = r.stdout[0];
  if (c === " ") return "ok";
  if (c === "+") return "moved";
  if (c === "-") return "uninit";
  if (c === "U") return "conflict";
  return "?";
}

function aheadBehind(dir: string): { ahead: string; behind: string } {
  const r = runGit(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (!r.success) return { ahead: "", behind: "" };
  const [behind, ahead] = r.stdout.trim().split(/\s+/);
  return { ahead: ahead && ahead !== "0" ? ahead : "", behind: behind && behind !== "0" ? behind : "" };
}

// ─── Git state inspection: the shared spine for status JSON, commit, record, sync/unsync, pull/push ───

/** Short HEAD SHA, or null when it cannot be read (unlike shortSha, which returns a sentinel). */
function headShortSha(dir: string): string | null {
  const r = runGit(dir, ["rev-parse", "--short", "HEAD"]);
  return r.success ? r.stdout.trim() || null : null;
}

type HeadState = { branch: string | null; head: string | null; detached: boolean };

/** Branch/head/detached snapshot. branch is null when detached or unborn; detached implies a real HEAD commit. */
function headState(dir: string): HeadState {
  const branch = currentBranch(dir);
  const head = headShortSha(dir);
  return { branch, head, detached: branch === null && head !== null };
}

type TrackingState = { trackingBranch: string | null; ahead: number | null; behind: number | null };

/** Upstream divergence as numbers; all null when there is no tracking branch or it cannot be compared. */
function trackingState(dir: string): TrackingState {
  const up = runGit(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const trackingBranch = up.success ? up.stdout.trim() || null : null;
  if (!trackingBranch) return { trackingBranch: null, ahead: null, behind: null };
  const r = runGit(dir, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  if (!r.success) return { trackingBranch, ahead: null, behind: null };
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  return {
    trackingBranch,
    ahead: Number.isNaN(ahead) ? null : ahead,
    behind: Number.isNaN(behind) ? null : behind,
  };
}

type ChangeCounts = { staged: number; unstaged: number; untracked: number };

/**
 * Count changed paths from `git status --porcelain=v1 -z`. A staged rename/copy entry consumes the
 * following NUL token (its source path) and counts once. Paths in excludePaths (submodule gitlinks)
 * are skipped so root counts exclude submodule pointers. Returns zero counts on failure.
 */
function changeCounts(dir: string, excludePaths: Set<string>): ChangeCounts {
  const counts: ChangeCounts = { staged: 0, unstaged: 0, untracked: 0 };
  const r = runGit(dir, ["status", "--porcelain=v1", "-z"]);
  if (!r.success) return counts;
  const tokens = r.stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 3) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    // A staged rename/copy emits "<XY> <dest>\0<src>\0"; consume the trailing source token.
    if (x === "R" || x === "C") i++;
    if (excludePaths.has(path)) continue;
    if (x === "?" && y === "?") {
      counts.untracked++;
      continue;
    }
    if (x !== " " && x !== "?") counts.staged++;
    if (y !== " " && y !== "?") counts.unstaged++;
  }
  return counts;
}

function isDirtyCounts(c: ChangeCounts): boolean {
  return c.staged > 0 || c.unstaged > 0 || c.untracked > 0;
}

/** Name of an in-progress Git operation (merge/rebase/cherry-pick/revert/bisect) in dir, or null when idle. */
function gitOperationInProgress(dir: string): string | null {
  const markers: Array<[string, string]> = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"],
  ];
  for (const [name, label] of markers) {
    const p = runGit(dir, ["rev-parse", "--git-path", name]);
    if (!p.success) continue;
    if (existsSync(resolve(dir, p.stdout.trim()))) return label;
  }
  return null;
}

type PinValue = "ok" | "moved" | "uninit" | "missing" | "conflict";

type GitlinkState = {
  alias: string;
  /** Root HEAD recorded gitlink OID, or null when HEAD records no gitlink for the path. */
  headOid: string | null;
  /** Root index gitlink OID at stage 0, or null when absent or conflicted. */
  indexOid: string | null;
  /** Submodule working tree HEAD OID, or null when uninitialized or the path was removed. */
  worktreeOid: string | null;
  /** Root index has unmerged stages for the path. */
  conflict: boolean;
  /** Submodule working tree is initialized (has a .git gitlink). */
  initialized: boolean;
  /** The oms/<alias> working tree path exists. */
  pathExists: boolean;
  /** .gitmodules registers oms/<alias>. */
  gitmodulesEntry: boolean;
  moved: boolean;
  staged: boolean;
  split: boolean;
  pin: PinValue;
};

/** Root HEAD gitlink OID for oms/<alias>, or null when HEAD records no gitlink there. */
function headGitlinkOid(repoRoot: string, alias: string): string | null {
  const r = runGit(repoRoot, ["ls-tree", "HEAD", "--", submodulePath(alias)]);
  if (!r.success) return null;
  const m = r.stdout.match(/^160000 commit ([0-9a-f]+)\t/m);
  return m ? m[1] : null;
}

/** Root index gitlink OID at stage 0 for oms/<alias>, or null when absent or conflicted. */
function indexGitlinkOid(repoRoot: string, alias: string): string | null {
  const r = runGit(repoRoot, ["ls-files", "--stage", "--", submodulePath(alias)]);
  if (!r.success) return null;
  const m = r.stdout.match(/^160000 ([0-9a-f]+) 0\t/m);
  return m ? m[1] : null;
}

/** True when the root index has unmerged (conflicted) entries for oms/<alias>. */
function gitlinkConflicted(repoRoot: string, alias: string): boolean {
  const r = runGit(repoRoot, ["ls-files", "-u", "--", submodulePath(alias)]);
  return r.success && r.stdout.trim().length > 0;
}

/**
 * Classify a submodule's root pointer state from HEAD/index/worktree OIDs — the shared spine reused by
 * status JSON, commit/record preconditions, sync/unsync topology, and pull/push follow-up hints.
 */
function gitlinkState(repoRoot: string, alias: string): GitlinkState {
  const headOid = headGitlinkOid(repoRoot, alias);
  const indexOid = indexGitlinkOid(repoRoot, alias);
  const conflict = gitlinkConflicted(repoRoot, alias);
  const initialized = submoduleInitialized(repoRoot, alias);
  const pathExists = existsSync(aliasDir(repoRoot, alias));
  const gitmodulesEntry = isRegisteredSubmodule(repoRoot, submodulePath(alias));
  const worktreeOid = initialized
    ? runGit(aliasDir(repoRoot, alias), ["rev-parse", "HEAD"]).stdout.trim() || null
    : null;

  const moved =
    headOid !== null
    && (!pathExists
      || (indexOid !== null && indexOid !== headOid)
      || (worktreeOid !== null && worktreeOid !== headOid));
  const staged = headOid !== null && indexOid !== null && indexOid !== headOid;
  const split = staged && worktreeOid !== null && indexOid !== worktreeOid;

  let pin: PinValue;
  if (conflict) pin = "conflict";
  else if (headOid === null) pin = "missing";
  else if (!initialized) pin = "uninit";
  else if (moved) pin = "moved";
  else pin = "ok";

  return {
    alias,
    headOid,
    indexOid,
    worktreeOid,
    conflict,
    initialized,
    pathExists,
    gitmodulesEntry,
    moved,
    staged,
    split,
    pin,
  };
}

/** Root HEAD has no gitlink, the working tree has an initialized submodule, and .gitmodules registers it. */
function pendingAddTopology(s: GitlinkState): boolean {
  return s.headOid === null && s.initialized && s.gitmodulesEntry;
}

/** Root HEAD has a gitlink but both the working tree path and the .gitmodules entry are gone. */
function pendingRemovalTopology(s: GitlinkState): boolean {
  return s.headOid !== null && !s.pathExists && !s.gitmodulesEntry;
}

/** Root HEAD has a gitlink and exactly one of the working tree path or .gitmodules entry is gone. */
function partialRemovalTopology(s: GitlinkState): boolean {
  return s.headOid !== null && !s.pathExists !== !s.gitmodulesEntry;
}

/**
 * The consistent root follow-up hint after a successful commit/pull/push: record an existing moved
 * pointer, create the topology commit for a pending add, or nothing. Never points at `oms record`
 * when record would reject the state (missing recorded gitlink, conflict, or pending removal).
 */
function rootFollowupHint(alias: string, s: GitlinkState): string | null {
  if (s.headOid !== null && s.pathExists && !s.conflict && s.moved) {
    return `Run "oms record ${alias}" to record the root pointer update.`;
  }
  if (pendingAddTopology(s)) {
    return `Run "oms sync ${alias} --commit" to create the topology commit.`;
  }
  return null;
}

/**
 * Infer the alias when the current directory is inside a configured oms/<alias>/ subtree. Matching is
 * path-segment based, so oms/api-extra never resolves to alias api. Inference succeeds even when the
 * submodule is uninitialized; the calling command enforces its own preconditions afterward.
 */
function inferAliasFromCwd(repoRoot: string, repos: Repo[], cwd: string = process.cwd()): string | null {
  const rel = relative(repoRoot, resolve(cwd));
  if (rel.startsWith("..")) return null;
  const parts = normalizePath(rel).split("/").filter(Boolean);
  if (parts.length >= 2 && parts[0] === DATA_DIRNAME) {
    const candidate = parts[1];
    if (repos.some((r) => r.alias === candidate)) return candidate;
  }
  return null;
}

type AliasResolution =
  | { kind: "alias"; alias: string }
  | { kind: "noop" }
  | { kind: "error" };

/**
 * Resolve a single alias for commit/record: explicit argument, then current-path inference, then an
 * interactive command-specific candidate list, then a non-interactive alias-required failure. Candidate
 * filters are command-specific (commit: dirty submodules; record: moved pointers). Interactive zero
 * candidates is a no-op exit 0; one candidate auto-selects; several show a picker.
 */
async function resolveCommandAlias(
  repos: Repo[],
  repoRoot: string,
  alias: string | undefined,
  command: "commit" | "record",
): Promise<AliasResolution> {
  if (alias) {
    if (!repos.some((r) => r.alias === alias)) {
      log.error(`Unknown alias "${alias}". Use "oms sync --list" to see registered aliases.`);
      return { kind: "error" };
    }
    return { kind: "alias", alias };
  }

  const inferred = inferAliasFromCwd(repoRoot, repos);
  if (inferred) return { kind: "alias", alias: inferred };

  if (!process.stdin.isTTY) {
    log.error(`No alias given and stdin is not a TTY. Pass an alias: "oms ${command} <alias>".`);
    return { kind: "error" };
  }

  const candidates = repos
    .filter((r) =>
      command === "commit"
        ? submoduleInitialized(repoRoot, r.alias) && isDirty(aliasDir(repoRoot, r.alias))
        : gitlinkState(repoRoot, r.alias).pin === "moved",
    )
    .map((r) => r.alias);

  if (candidates.length === 0) {
    log.info(
      command === "commit"
        ? "Nothing to commit in any submodule."
        : "Nothing to record for any submodule.",
    );
    return { kind: "noop" };
  }
  if (candidates.length === 1) {
    log.info(
      `Selected "${candidates[0]}" (the only ${command === "commit" ? "dirty submodule" : "moved pointer"}).`,
    );
    return { kind: "alias", alias: candidates[0] };
  }

  const choice = await select({
    message: `Select a submodule to ${command}`,
    options: candidates.map((a) => ({ value: a, label: a })),
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return { kind: "error" };
  }
  return { kind: "alias", alias: choice as string };
}

/** Machine-readable per-repo status entry. See design.md for the stable schemaVersion 1 contract. */
type JsonRepoStatus = {
  alias: string;
  path: string;
  absolutePath: string;
  configured: boolean;
  initialized: boolean;
  branch: string | null;
  head: string | null;
  detached: boolean;
  trackingBranch: string | null;
  pin: PinValue;
  dirty: boolean;
  changes: ChangeCounts;
  ahead: number | null;
  behind: number | null;
  error: string | null;
};

type JsonRootStatus = {
  branch: string | null;
  head: string | null;
  detached: boolean;
  dirty: boolean;
  changes: ChangeCounts;
  submodulePointers: {
    moved: string[];
    staged: string[];
    split: string[];
    conflict: string[];
  };
};

type JsonStatus = {
  schemaVersion: 1;
  toolVersion: string;
  workspaceRoot: string;
  currentAlias: string | null;
  root: JsonRootStatus;
  repos: JsonRepoStatus[];
  errors: string[];
};

/**
 * Build one repo's JSON status. Never throws: an initialized repo whose HEAD cannot be read keeps the
 * normal entry shape with null scalars, safe-default structured fields, and a concise `error` message.
 */
function buildRepoStatus(repoRoot: string, repo: Repo): JsonRepoStatus {
  const state = gitlinkState(repoRoot, repo.alias);
  const common = {
    alias: repo.alias,
    path: submodulePath(repo.alias),
    absolutePath: aliasDir(repoRoot, repo.alias),
    configured: true,
    pin: state.pin,
  };
  const safeDefaults = {
    branch: null,
    head: null,
    detached: false,
    trackingBranch: null,
    dirty: false,
    changes: { staged: 0, unstaged: 0, untracked: 0 },
    ahead: null,
    behind: null,
  };
  if (!state.initialized) {
    return { ...common, initialized: false, ...safeDefaults, error: null };
  }
  const dir = aliasDir(repoRoot, repo.alias);
  const head = headShortSha(dir);
  if (head === null) {
    return {
      ...common,
      initialized: true,
      ...safeDefaults,
      error: `${repo.alias}: could not read submodule HEAD`,
    };
  }
  const branch = currentBranch(dir);
  const { trackingBranch, ahead, behind } = trackingState(dir);
  const changes = changeCounts(dir, new Set());
  return {
    ...common,
    initialized: true,
    branch,
    head,
    detached: branch === null,
    trackingBranch,
    dirty: isDirtyCounts(changes),
    changes,
    ahead,
    behind,
    error: null,
  };
}

/**
 * Build the root JSON status. root.changes always excludes every configured submodule gitlink path so
 * pointer movement is reported only through submodulePointers, whose arrays cover the selected repos.
 */
function buildRootStatus(repoRoot: string, configuredRepos: Repo[], selectedRepos: Repo[]): JsonRootStatus {
  const { branch, head, detached } = headState(repoRoot);
  const excludePaths = new Set<string>([
    ...registeredSubmodulePaths(repoRoot),
    ...configuredRepos.map((r) => submodulePath(r.alias)),
  ]);
  const changes = changeCounts(repoRoot, excludePaths);
  const pointers = { moved: [] as string[], staged: [] as string[], split: [] as string[], conflict: [] as string[] };
  for (const repo of selectedRepos) {
    const s = gitlinkState(repoRoot, repo.alias);
    if (s.conflict) pointers.conflict.push(repo.alias);
    if (s.moved) pointers.moved.push(repo.alias);
    if (s.staged) pointers.staged.push(repo.alias);
    if (s.split) pointers.split.push(repo.alias);
  }
  return { branch, head, detached, dirty: isDirtyCounts(changes), changes, submodulePointers: pointers };
}

/** Emit exactly one two-space pretty JSON object on stdout. Exits non-zero if any repo read failed. */
function printStatusJson(repoRoot: string, configuredRepos: Repo[], selectedRepos: Repo[]): number {
  const repos = selectedRepos.map((repo) => buildRepoStatus(repoRoot, repo));
  const errors = repos.filter((r) => r.error !== null).map((r) => r.error as string);
  const payload: JsonStatus = {
    schemaVersion: 1,
    toolVersion: readPackageVersion(),
    workspaceRoot: repoRoot,
    currentAlias: inferAliasFromCwd(repoRoot, configuredRepos),
    root: buildRootStatus(repoRoot, configuredRepos, selectedRepos),
    repos,
    errors,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return errors.length > 0 ? 2 : 0;
}

async function runStatus(aliases: string[], options: StatusOptions): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  let selected: Repo[];
  if (options.all || aliases.length === 0) {
    selected = repos;
  } else {
    const unknown = aliases.filter((a) => !repos.some((r) => r.alias === a));
    if (unknown.length > 0) {
      const msg = `Unknown alias(es): ${unknown.join(", ")}. Use "oms sync --list" to see available aliases.`;
      if (options.json) process.stderr.write(`${msg}\n`);
      else log.error(msg);
      return 1;
    }
    const byAlias = new Map(repos.map((r) => [r.alias, r]));
    selected = uniqueAliases(aliases).map((a) => byAlias.get(a)!);
  }

  if (options.json) {
    return printStatusJson(repoRoot, repos, selected);
  }

  const rows: StatusRow[] = [];
  for (const repo of selected) {
    const state = gitlinkState(repoRoot, repo.alias);
    if (!state.initialized) {
      rows.push({ alias: repo.alias, branch: "(not synced)", pin: state.pin, dirty: "", ahead: "", behind: "" });
      continue;
    }
    const dir = aliasDir(repoRoot, repo.alias);
    const branch = currentBranch(dir) ?? `(detached ${shortSha(dir)})`;
    const { ahead, behind } = aheadBehind(dir);
    rows.push({
      alias: repo.alias,
      branch,
      pin: state.pin,
      dirty: isDirty(dir) ? "yes" : "",
      ahead,
      behind,
    });
  }

  const col = (key: keyof StatusRow, header: string) =>
    Math.max(header.length, ...rows.map((r) => r[key].length));
  const aW = col("alias", "ALIAS");
  const bW = col("branch", "BRANCH");
  const pW = col("pin", "PIN");
  const dW = Math.max("DIRTY".length, ...rows.map((r) => r.dirty.length));
  console.log(
    dim(
      `${pad("ALIAS", aW)}  ${pad("BRANCH", bW)}  ${pad("PIN", pW)}  ${pad("DIRTY", dW)}  AHEAD  BEHIND`,
    ),
  );
  for (const r of rows) {
    console.log(
      `${pad(r.alias, aW)}  ${pad(r.branch, bW)}  ${pad(r.pin, pW)}  ${pad(r.dirty, dW)}  ${pad(r.ahead, 5)}  ${r.behind}`,
    );
  }
  return 0;
}

/** Print the consistent root follow-up hint (record / topology commit) for the current pointer state. */
function printRootFollowup(repoRoot: string, alias: string): void {
  const hint = rootFollowupHint(alias, gitlinkState(repoRoot, alias));
  if (hint) log.info(hint);
}

/**
 * Commit only inside the selected submodule. Respects an existing submodule index (staged-first): when
 * something is already staged it commits just that and warns about leftovers; otherwise it stages all
 * changes with `git add -A`. Never stages or commits the root gitlink.
 */
async function runCommit(alias: string | undefined, options: CommitOptions): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const resolution = await resolveCommandAlias(repos, repoRoot, alias, "commit");
  if (resolution.kind === "error") return 1;
  if (resolution.kind === "noop") return 0;
  const selected = resolution.alias;
  const dir = aliasDir(repoRoot, selected);

  if (!submoduleInitialized(repoRoot, selected)) {
    log.error(`${selected}: not initialized. Run "oms sync ${selected}" to initialize it first.`);
    return 1;
  }
  // Check for an in-progress operation before detached HEAD, since a rebase detaches HEAD and should
  // report "rebase in progress" rather than a generic detached-HEAD message.
  const op = gitOperationInProgress(dir);
  if (op) {
    log.error(
      `${selected}: a ${op} is in progress inside oms/${selected}. Resolve, continue, or abort it first.`,
    );
    return 1;
  }
  if (currentBranch(dir) === null) {
    log.error(`${selected}: detached HEAD. Run "oms switch ${selected} <branch>" before committing.`);
    return 1;
  }

  const messages = options.message ?? [];
  const counts = changeCounts(dir, new Set());
  if (!isDirtyCounts(counts)) {
    log.info(`Nothing to commit for ${selected}.`);
    printRootFollowup(repoRoot, selected);
    return 0;
  }
  if (messages.length === 0) {
    log.error(`${selected}: -m is required to create a submodule commit. Re-run with -m "<message>".`);
    return 1;
  }

  const commitArgs = ["commit", ...messages.flatMap((m) => ["-m", m])];
  if (counts.staged > 0) {
    log.step(`${selected}: git commit (staged changes only)`);
    if (!runSub(repoRoot, selected, commitArgs, true).success) return 2;
    if (counts.unstaged > 0 || counts.untracked > 0) {
      log.warn(
        `${selected}: committed staged changes only; unstaged or untracked changes remain uncommitted.`,
      );
    }
  } else {
    log.step(`${selected}: git add -A && git commit`);
    if (!runSub(repoRoot, selected, ["add", "-A"], true).success) return 2;
    if (!runSub(repoRoot, selected, commitArgs, true).success) return 2;
  }

  log.success(`${selected}: committed ${shortSha(dir)}`);
  printRootFollowup(repoRoot, selected);
  return 0;
}

/** Root index paths staged relative to HEAD, read NUL-delimited so unusual path names stay intact. */
function stagedRootPaths(repoRoot: string): string[] {
  const r = runGit(repoRoot, ["diff", "--cached", "--name-only", "-z"]);
  if (!r.success) return [];
  return r.stdout.split("\0").filter((p) => p.length > 0);
}

/**
 * Record an existing root gitlink pointer update for the selected submodule with a path-limited root
 * commit. Strict index safety keeps the commit scoped to exactly oms/<alias>; it never adds or removes
 * a submodule registration (that is sync/unsync topology) and never includes unrelated staged paths.
 */
async function runRecord(alias: string | undefined): Promise<number> {
  const loaded = loadForSubmodules();
  if (!loaded) return 1;
  const { repos, repoRoot } = loaded;

  const resolution = await resolveCommandAlias(repos, repoRoot, alias, "record");
  if (resolution.kind === "error") return 1;
  if (resolution.kind === "noop") return 0;
  const selected = resolution.alias;
  const path = submodulePath(selected);

  const state = gitlinkState(repoRoot, selected);

  // A conflicted gitlink is the specific blocker, so report it ahead of the generic in-progress merge
  // it implies; an in-progress operation that does not conflict this gitlink is reported next.
  if (state.conflict) {
    log.error(`${selected}: the root gitlink is conflicted. Resolve the root repository conflict first.`);
    return 1;
  }
  const rootOp = gitOperationInProgress(repoRoot);
  if (rootOp) {
    log.error(`Root repository has a ${rootOp} in progress. Resolve, continue, or abort it before recording.`);
    return 1;
  }
  if (currentBranch(repoRoot) === null) {
    log.error(`Root repository is in detached HEAD. Switch the root repository to a branch before recording.`);
    return 1;
  }

  if (state.headOid === null) {
    const topology = pendingAddTopology(state)
      ? ` Create the initial topology commit with "oms sync ${selected} --commit".`
      : "";
    log.error(
      `${selected}: the root HEAD has no recorded gitlink. "oms record" only updates existing root gitlinks.${topology}`,
    );
    return 1;
  }
  if (!state.pathExists) {
    log.error(`${selected}: pending submodule removal. Record the removal with "oms unsync ${selected} --commit".`);
    return 1;
  }
  if (state.split) {
    log.error(
      `${selected}: the staged oms/${selected} pointer differs from the working tree. Unstage or restage oms/${selected}, then retry.`,
    );
    return 1;
  }

  // Index safety: only the selected gitlink may be staged (NUL-delimited, child paths count as unrelated).
  const unrelated = stagedRootPaths(repoRoot).filter((p) => p !== path);
  if (unrelated.length > 0) {
    log.error(
      `Root repository has unrelated staged changes (${unrelated.join(", ")}). Commit or unstage them before recording.`,
    );
    return 1;
  }

  // Record the current working tree HEAD pointer; no movement is a clean no-op.
  if (state.worktreeOid === null || state.worktreeOid === state.headOid) {
    log.info(`Nothing to record for ${selected}.`);
    return 0;
  }

  if (isDirty(aliasDir(repoRoot, selected))) {
    log.warn(`${selected}: submodule has uncommitted source changes; only the current HEAD pointer will be recorded.`);
  }

  const message = `chore(oms): update ${selected} submodule to ${shortSha(aliasDir(repoRoot, selected))}`;
  if (!runGit(repoRoot, ["add", "--", path]).success) {
    log.error(`${selected}: failed to stage oms/${selected}.`);
    return 2;
  }
  const commit = runGit(repoRoot, ["commit", "-m", message, "--", path], true);
  if (!commit.success) {
    log.error(`${selected}: root commit failed; the staged oms/${selected} pointer was left in place.`);
    return 2;
  }
  log.success(`${selected}: recorded ${shortSha(repoRoot)}  ${message}`);
  return 0;
}

type TopologyKind = "add" | "remove";

/** Unstage only the topology paths (.gitmodules + selected gitlinks), preserving unrelated staged paths. */
function unstageTopologyPaths(repoRoot: string, aliases: string[]): void {
  runGit(repoRoot, ["reset", "-q", "HEAD", "--", ".gitmodules", ...aliases.map(submodulePath)]);
}

function topologyCommitMessage(kind: TopologyKind, aliases: string[]): string {
  if (kind === "add") {
    return aliases.length === 1 ? `chore(oms): add ${aliases[0]} submodule` : "chore(oms): add submodules";
  }
  return aliases.length === 1 ? `chore(oms): remove ${aliases[0]} submodule` : "chore(oms): remove submodules";
}

/** Root index paths staged outside the given topology path set (.gitmodules + selected gitlinks). */
function unrelatedStagedTopologyPaths(repoRoot: string, aliases: string[]): string[] {
  const topo = new Set([".gitmodules", ...aliases.map(submodulePath)]);
  return stagedRootPaths(repoRoot).filter((p) => !topo.has(p));
}

/** Stage the topology paths (adds and removals) and create a path-limited root commit for them. */
function commitTopologyPaths(repoRoot: string, aliases: string[], message: string): GitResult {
  const paths = [".gitmodules", ...aliases.map(submodulePath)];
  runGit(repoRoot, ["add", "-A", "--", ...paths]);
  return runGit(repoRoot, ["commit", "-m", message, "--", ...paths], true);
}

/** Ask whether to create a root topology commit; defaults to Yes. Returns null on cancellation. */
async function confirmTopologyCommit(message: string): Promise<boolean | null> {
  const choice = await select({
    message: "Create a root topology commit?",
    options: [
      { value: "yes", label: `Yes, commit "${message}"` },
      { value: "no", label: "No, leave the topology changes unstaged" },
    ],
    initialValue: "yes",
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return choice === "yes";
}

/**
 * Decide what happens to root topology changes after a successful sync/unsync: create a path-limited
 * topology commit (explicit `--commit`, or an interactive accept) or leave the changes unstaged by
 * default. A multi-alias commit happens only when every requested alias succeeded; partial removal
 * topology is rejected rather than committed. Returns a non-zero contribution on topology failure.
 */
async function finalizeTopology(
  repoRoot: string,
  requested: string[],
  kind: TopologyKind,
  commit: boolean,
  allSucceeded: boolean,
): Promise<number> {
  const pending: string[] = [];
  const partial: string[] = [];
  for (const alias of requested) {
    const s = gitlinkState(repoRoot, alias);
    if (kind === "add") {
      if (pendingAddTopology(s)) pending.push(alias);
    } else if (partialRemovalTopology(s)) {
      partial.push(alias);
    } else if (pendingRemovalTopology(s)) {
      pending.push(alias);
    }
  }
  if (pending.length === 0 && partial.length === 0) return 0;
  const involved = [...pending, ...partial];

  // Decide whether a commit is created: explicit --commit, or an interactive accept (default Yes).
  let createCommit = commit;
  let declined = false;
  if (!commit && process.stdin.isTTY && allSucceeded && partial.length === 0) {
    const confirmed = await confirmTopologyCommit(topologyCommitMessage(kind, pending));
    if (confirmed === null) {
      unstageTopologyPaths(repoRoot, involved);
      return 1;
    }
    createCommit = confirmed;
    declined = !confirmed;
  }

  if (!createCommit) {
    unstageTopologyPaths(repoRoot, involved);
    if (!declined) {
      log.info("Root topology changes left unstaged. Review them, or re-run with --commit to record the topology change.");
    }
    return 0;
  }

  // A commit was requested or accepted; reject states that must not be committed.
  if (partial.length > 0) {
    log.error(
      `Partial removal topology for ${partial.join(", ")} must be cleaned up before committing. Complete the removal (or restore the submodule), then retry.`,
    );
    unstageTopologyPaths(repoRoot, involved);
    return 2;
  }
  if (!allSucceeded) {
    unstageTopologyPaths(repoRoot, involved);
    log.info(`Not all aliases succeeded; topology changes for ${pending.join(", ")} were left unstaged for manual review.`);
    return 0;
  }
  const unrelated = unrelatedStagedTopologyPaths(repoRoot, pending);
  if (unrelated.length > 0) {
    log.error(
      `Root repository has unrelated staged changes (${unrelated.join(", ")}). Commit or unstage them before the topology commit.`,
    );
    unstageTopologyPaths(repoRoot, pending);
    return 2;
  }
  const message = topologyCommitMessage(kind, pending);
  if (!commitTopologyPaths(repoRoot, pending, message).success) {
    log.error("Root topology commit failed; staged topology paths were left in place.");
    return 2;
  }
  log.success(`Recorded topology commit ${shortSha(repoRoot)}  ${message}`);
  return 0;
}

const OMS_MARKER_START = "<!-- OMS START -->";
const OMS_MARKER_END = "<!-- OMS END -->";

/** Concise, durable agent rules; detailed usage is deferred to CLI help. */
const OMS_INSTRUCTION_BLOCK = `${OMS_MARKER_START}
## OMS Workspace Rules

- Run \`oms status --json\` before Git work involving \`oms/\` to read root versus submodule state.
- Treat each \`oms/<alias>/\` directory as a separate Git repository.
- Use \`oms\` commands for scoped submodule workflows; do not guess root repository versus submodule Git scope.
- Do not create root commits for existing submodule pointer updates unless the user explicitly runs \`oms record <alias>\`.
- Check \`oms --help\` and \`oms <command> --help\` for exact command usage.
${OMS_MARKER_END}`;

type ManagedBlockState =
  | { kind: "missing" }
  | { kind: "valid"; before: string; after: string }
  | { kind: "malformed"; reason: string };

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Classify the OMS marker state of a file: missing, exactly one valid block, or malformed. */
function analyzeManagedBlock(content: string): ManagedBlockState {
  const starts = countOccurrences(content, OMS_MARKER_START);
  const ends = countOccurrences(content, OMS_MARKER_END);
  if (starts === 0 && ends === 0) return { kind: "missing" };
  if (starts !== 1 || ends !== 1) {
    return { kind: "malformed", reason: "expected exactly one matched OMS START/END marker pair" };
  }
  const startIdx = content.indexOf(OMS_MARKER_START);
  const endIdx = content.indexOf(OMS_MARKER_END);
  if (endIdx < startIdx) {
    return { kind: "malformed", reason: "OMS END marker appears before OMS START" };
  }
  return {
    kind: "valid",
    before: content.slice(0, startIdx),
    after: content.slice(endIdx + OMS_MARKER_END.length),
  };
}

/** Collapse trailing newlines to exactly one. */
function normalizeTrailingNewline(content: string): string {
  return `${content.replace(/\n+$/, "")}\n`;
}

/** Compute the post-install content for a target file: create, append after two blank lines, or replace. */
function installManagedBlock(existing: string | null): string {
  if (existing === null || existing.trim() === "") return `${OMS_INSTRUCTION_BLOCK}\n`;
  const state = analyzeManagedBlock(existing);
  if (state.kind === "valid") {
    return normalizeTrailingNewline(`${state.before}${OMS_INSTRUCTION_BLOCK}${state.after}`);
  }
  // Non-empty file with no block: append after two blank lines, preserving existing content.
  return `${existing.replace(/\n+$/, "")}\n\n\n${OMS_INSTRUCTION_BLOCK}\n`;
}

type AgentFile = { path: string; rel: string };

function agentTargetFiles(repoRoot: string, target: AgentTarget): AgentFile[] {
  const names = target === "agents" ? ["AGENTS.md"] : target === "claude" ? ["CLAUDE.md"] : ["AGENTS.md", "CLAUDE.md"];
  return names.map((name) => ({
    path: join(repoRoot, DATA_DIRNAME, name),
    rel: `${DATA_DIRNAME}/${name}`,
  }));
}

/** Resolve the install/uninstall target: explicit --target, interactive prompt, or non-interactive failure. */
async function resolveAgentTarget(target: string | undefined): Promise<AgentTarget | null> {
  if (target !== undefined) {
    if (target !== "agents" && target !== "claude" && target !== "both") {
      log.error(`Invalid --target "${target}". Use --target agents|claude|both.`);
      return null;
    }
    return target;
  }
  if (!process.stdin.isTTY) {
    log.error(`--target is required in a non-interactive shell. Pass --target agents|claude|both.`);
    return null;
  }
  const choice = await select({
    message: "Which instruction file(s) should OMS manage?",
    options: [
      { value: "agents", label: `${DATA_DIRNAME}/AGENTS.md` },
      { value: "claude", label: `${DATA_DIRNAME}/CLAUDE.md` },
      { value: "both", label: `${DATA_DIRNAME}/AGENTS.md + ${DATA_DIRNAME}/CLAUDE.md` },
    ],
  });
  if (isCancel(choice)) {
    cancel("Cancelled.");
    return null;
  }
  return choice as AgentTarget;
}

/** Validate that no selected file has malformed markers before any write (atomic pre-write check). */
function validateAgentFiles(files: AgentFile[], action: string): boolean {
  for (const file of files) {
    if (!existsSync(file.path)) continue;
    const state = analyzeManagedBlock(readFileSync(file.path, "utf8"));
    if (state.kind === "malformed") {
      log.error(`${file.rel}: ${state.reason}. Fix the OMS markers, then retry. No files were ${action}.`);
      return false;
    }
  }
  return true;
}

async function runAgentInstall(options: AgentOptions): Promise<number> {
  const repoRoot = findWorkspaceRoot();
  if (!repoRoot) {
    log.error(`Could not find ${MANIFEST_FILENAME} in the current directory or its parents.`);
    return 1;
  }
  const target = await resolveAgentTarget(options.target);
  if (!target) return 1;
  const files = agentTargetFiles(repoRoot, target);

  if (!validateAgentFiles(files, "modified")) return 1;

  mkdirSync(join(repoRoot, DATA_DIRNAME), { recursive: true });
  for (const file of files) {
    const existing = existsSync(file.path) ? readFileSync(file.path, "utf8") : null;
    writeFileSync(file.path, installManagedBlock(existing));
    log.success(`${file.rel}: OMS instructions installed.`);
  }
  log.info("OMS instruction files are not staged; review and commit them yourself.");
  return 0;
}

async function runAgentUninstall(options: AgentOptions): Promise<number> {
  const repoRoot = findWorkspaceRoot();
  if (!repoRoot) {
    log.error(`Could not find ${MANIFEST_FILENAME} in the current directory or its parents.`);
    return 1;
  }
  const target = await resolveAgentTarget(options.target);
  if (!target) return 1;
  const files = agentTargetFiles(repoRoot, target);

  if (!validateAgentFiles(files, "modified")) return 1;

  for (const file of files) {
    if (!existsSync(file.path)) {
      log.info(`${file.rel}: no OMS block found.`);
      continue;
    }
    const state = analyzeManagedBlock(readFileSync(file.path, "utf8"));
    if (state.kind !== "valid") {
      // missing here; malformed was already rejected by the pre-write validation above.
      log.info(`${file.rel}: no OMS block found.`);
      continue;
    }
    const remaining = state.before + state.after;
    if (remaining.trim() === "") {
      rmSync(file.path);
      log.success(`${file.rel}: removed OMS block and deleted the now-empty file.`);
    } else {
      writeFileSync(file.path, normalizeTrailingNewline(remaining));
      log.success(`${file.rel}: removed OMS block.`);
    }
  }
  return 0;
}

const INIT_TEMPLATE = `# yaml-language-server: $schema=https://raw.githubusercontent.com/divlook/oh-my-space/main/oms.schema.json
repos:
  - alias: example
    remotes:
      origin: git@github.com:example/repo.git
      # upstream: git@github.com:upstream/repo.git
    branch: main
`;

/** 현재 디렉터리에 기본 oms.yaml 템플릿을 생성합니다. */
async function runInit(options: { force?: boolean }): Promise<number> {
  const target = join(process.cwd(), MANIFEST_FILENAME);
  if (existsSync(target) && !options.force) {
    log.error(`${MANIFEST_FILENAME} already exists at ${target}. Use --force to overwrite.`);
    return 1;
  }
  writeFileSync(target, INIT_TEMPLATE);
  log.success(`created ${MANIFEST_FILENAME} at ${target}`);
  // Sources are tracked submodules, so make sure no stale oms version left oms/ ignored.
  ensureOmsNotIgnored(process.cwd());
  if (!isGitRepo(process.cwd())) {
    log.info(`oms manages sources as git submodules; run "git init" here if this is not a git repo yet.`);
  }
  log.info(`edit alias/remotes/branch, then run "oms sync".`);
  return 0;
}

async function runDoctor(): Promise<number> {
  const loaded = loadRepos();
  if (!loaded) {
    emitLegacyRenameHintWalkUp();
    return 1;
  }
  const { repos, repoRoot } = loaded;
  if (abortOnLegacyRenameAt(repoRoot)) return 1;

  log.success(`Workspace root: ${repoRoot}`);
  log.success(`${MANIFEST_FILENAME}: ${repos.length} repo(s) configured`);

  const git = spawnSync("git", ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (git.status !== 0) {
    log.error("git: not found");
    return 1;
  }
  log.success(`git: ${git.stdout.trim()}`);

  let warnings = 0;

  const parsed = parseGitVersion(git.stdout);
  if (!parsed) {
    log.warn(
      `git: could not parse version from "${git.stdout.trim()}"; oms expects git >=${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}.`,
    );
    warnings++;
  } else if (!isGitVersionSupported(parsed)) {
    log.warn(
      `git ${parsed.major}.${parsed.minor} is older than the recommended ${MIN_GIT_MAJOR}.${MIN_GIT_MINOR}. oms uses "git switch" and submodule commands which may behave differently on older releases — upgrade git.`,
    );
    warnings++;
  }

  if (!isGitRepo(repoRoot)) {
    log.warn(
      `workspace is not a git repository. oms manages sources as submodules; run "git init" at ${repoRoot}.`,
    );
    warnings++;
  }

  if (abortOnLegacyWorktree(repoRoot, repos)) return 1;

  if (gitignoreIgnoresOms(repoRoot)) {
    log.warn(`.gitignore excludes ${GITIGNORE_ENTRY}, but submodules must be tracked. Run "oms sync" to remove it.`);
    warnings++;
  }

  for (const repo of repos) {
    if (!isRegisteredSubmodule(repoRoot, submodulePath(repo.alias))) {
      log.info(`${repo.alias}: not synced`);
      continue;
    }
    if (!submoduleInitialized(repoRoot, repo.alias)) {
      log.warn(`${repo.alias}: registered but not initialized. Run "oms sync ${repo.alias}".`);
      warnings++;
      continue;
    }
    const dir = aliasDir(repoRoot, repo.alias);
    const branch = currentBranch(dir);
    if (!branch) {
      log.warn(`${repo.alias}: detached HEAD. Run "oms switch ${repo.alias} <branch>" to get on a branch.`);
      warnings++;
    } else {
      log.success(`${repo.alias}: submodule OK (branch=${branch})`);
    }
    if (pinState(repoRoot, repo.alias) === "moved") {
      log.info(`${repo.alias}: working commit differs from the recorded pointer. Commit oms/${repo.alias} to record it.`);
    }
  }

  return warnings > 0 ? 2 : 0;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function readPackageVersion(): string {
  const pkg = readJson<{ version?: string }>(join(packageRoot, "package.json"));
  return pkg?.version ?? "0.0.0";
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

async function runUpdate(options: UpdateOptions): Promise<number> {
  let latestVersion: string;
  const currentVersion = readPackageVersion();
  try {
    latestVersion = await fetchLatestPackageVersion();
    const comparison = compareVersions(currentVersion, latestVersion);
    printUpdateHeader(currentVersion, latestVersion);
    if (comparison === 0) {
      log.success("oms is up to date.");
      return 0;
    }
    if (comparison > 0) {
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

/** The commit baked in at build time, or null when unavailable (dev/no-git build). */
function readBuildCommit(): string | null {
  const info = readJson<{ commit?: string | null }>(
    join(dirname(fileURLToPath(import.meta.url)), "build-info.json"),
  );
  return info?.commit ?? null;
}

/** Clickable GitHub permalink for a repo doc, pinned to the build commit; falls back to the version tag. */
function docUrl(relPath: string): string {
  const ref = readBuildCommit() ?? `v${readPackageVersion()}`;
  return `${DOCS_REPO_BLOB_BASE}/${ref}/${relPath}`;
}

async function exitWith(action: Promise<number>): Promise<void> {
  try {
    process.exit(await action);
  } catch (e) {
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

const exitHelp = "\nExit codes: 0 ok | 1 usage/config error | 2 one or more git operations failed.";

// Per-command help: each new or changed command states its purpose, scope boundary, and an example.
const statusHelp = `
Machine-readable mode prints exactly one JSON object on stdout (schemaVersion, root, repos, pointers).
Examples:
  $ oms status --json          # full workspace state for tools and agents
  $ oms status api --json      # narrow the JSON to one alias
`;
const commitHelp = `
Scope: commits inside the selected oms/<alias>/ submodule only — never the root gitlink. Existing staged
changes are committed as-is (staged-first); otherwise all changes are staged with git add -A.
Examples:
  $ oms commit api -m "feat: add login"   # commit submodule source changes
  $ oms commit -m "fix: typo"             # infer the alias from the current oms/<alias>/ directory
`;
const recordHelp = `
Scope: commits an existing root gitlink pointer update for one alias in the ROOT repository only
(chore(oms): update <alias> submodule to <sha>). It never adds or removes a submodule registration.
Example:
  $ oms record api
`;
const syncHelp = `
Root topology changes (.gitmodules, oms/<alias>) are left unstaged by default; create the topology
commit through the interactive prompt or with --commit.
Examples:
  $ oms sync api               # add/initialize/refresh oms/api (topology left unstaged)
  $ oms sync api --commit      # also create chore(oms): add api submodule
`;
const unsyncHelp = `
Root topology changes are left unstaged by default; create the removal topology commit through the
interactive prompt or with --commit.
Examples:
  $ oms unsync api             # remove oms/api (topology left unstaged)
  $ oms unsync api --commit    # also create chore(oms): remove api submodule
`;
const pullHelp = `
Scope: pulls the submodule branch only — it never stages or commits the root gitlink. Record a moved
root pointer afterward with "oms record <alias>".
Example:
  $ oms pull api
`;
const pushHelp = `
Scope: pushes the submodule branch only — it never stages or commits the root gitlink. Staging a pointer
for review is not the same as recording a pointer commit: "--commit" is unsupported, so push the branch
with "oms push <alias>", then record the existing root pointer update with "oms record <alias>".
Examples:
  $ oms push api
  $ oms record api             # record the moved root pointer
`;
const agentInstallHelp = `
Manages a marker-delimited block (<!-- OMS START --> ... <!-- OMS END -->) in oms/AGENTS.md and/or
oms/CLAUDE.md. These are root-repository files, not submodule files, and are not staged.
Example:
  $ oms agent install --target both
`;
const agentUninstallHelp = `
Removes the marker-delimited OMS block; a file left empty is deleted. Missing files or blocks are a no-op.
Example:
  $ oms agent uninstall --target both
`;
const commandNames = new Set([
  "init",
  "doctor",
  "sync",
  "status",
  "commit",
  "record",
  "switch",
  "checkout",
  "fetch",
  "pull",
  "push",
  "unsync",
  "agent",
  "update",
  "help",
]);

const collectMessage = (value: string, acc: string[]): string[] => [...acc, value];
const program = new Command();

program
  .name("oms")
  .description(
    `Manage source repositories listed in ${MANIFEST_FILENAME} as git submodules under ${DATA_DIRNAME}/<alias>/.`,
  )
  .version(readPackageVersion())
  .addHelpText("after", exitHelp);

program
  .command("init")
  .description(`Create a starter ${MANIFEST_FILENAME} in the current directory.`)
  .option("--force", `overwrite an existing ${MANIFEST_FILENAME}`)
  .addHelpText("after", exitHelp)
  .action(async (options: { force?: boolean }) => {
    await exitWith(runInit(options));
  });

program
  .command("doctor")
  .description(
    `Check ${MANIFEST_FILENAME}, git availability, and the submodule state of each registered alias.`,
  )
  .addHelpText("after", exitHelp)
  .action(async () => {
    await exitWith(runDoctor());
  });

program
  .command("sync")
  .description(
    `Register each repo as a submodule at ${DATA_DIRNAME}/<alias>/ (or initialize and refresh an existing one), checked out on its baseline branch.`,
  )
  .argument("[aliases...]", "repo aliases to sync (omit for interactive multi-select)")
  .option("--all", "sync every registered source repo")
  .option("--list", "print registered repos")
  .option("--commit", "create the root topology commit (chore(oms): add ...) without prompting")
  .addHelpText("after", `${syncHelp}${exitHelp}`)
  .action(async (aliases: string[], options: SyncCommitOptions) => {
    await exitWith(runSync(aliases, options));
  });

program
  .command("status")
  .description("Show each submodule's branch, pointer state, dirtiness, and ahead/behind counts.")
  .argument("[aliases...]", "repo aliases to inspect (omit for all)")
  .option("--all", "inspect every registered source repo")
  .option("--json", "print machine-readable workspace state (one JSON object on stdout)")
  .addHelpText("after", `${statusHelp}${exitHelp}`)
  .action(async (aliases: string[], options: StatusOptions) => {
    await exitWith(runStatus(aliases, options));
  });

program
  .command("commit")
  .description("Commit source changes inside the selected submodule only (never the root gitlink).")
  .argument("[alias]", "registered source alias (omit to infer from the current oms/<alias>/ directory)")
  .option("-m, --message <message>", "commit message (repeatable; required only to create a commit)", collectMessage, [])
  .addHelpText("after", `${commitHelp}${exitHelp}`)
  .action(async (alias: string | undefined, options: CommitOptions) => {
    await exitWith(runCommit(alias, options));
  });

program
  .command("record")
  .description("Commit an existing root gitlink pointer update for the selected submodule (root repo only).")
  .argument("[alias]", "registered source alias (omit to infer from the current oms/<alias>/ directory)")
  .addHelpText("after", `${recordHelp}${exitHelp}`)
  .action(async (alias: string | undefined) => {
    await exitWith(runRecord(alias));
  });

program
  .command("switch")
  .description(
    "Switch a submodule to a LOCAL branch, creating it locally if it does not exist yet (no remote required).",
  )
  .argument("[alias]", "registered source alias (omit to pick interactively)")
  .argument("[branch]", "local branch name (omit to pick from local branches or create one)")
  .option("--from <ref>", "start point for a new branch (default: current HEAD)")
  .addHelpText("after", exitHelp)
  .action(async (alias: string | undefined, branch: string | undefined, options: CheckoutOptions) => {
    await exitWith(runSwitch(alias, branch, options));
  });

program
  .command("checkout")
  .description(
    "Fetch origin, then check out a REMOTE branch (origin/*) as a local tracking branch.",
  )
  .argument("[alias]", "registered source alias (omit to pick interactively)")
  .argument("[branch]", "remote branch name (omit to pick from origin/* branches)")
  .addHelpText("after", exitHelp)
  .action(async (alias: string | undefined, branch: string | undefined) => {
    await exitWith(runCheckout(alias, branch));
  });

const collectRemote = (value: string, acc: string[]): string[] => [...acc, value];

program
  .command("fetch")
  .description("Run git fetch <remote> --prune in each submodule (defaults to origin).")
  .argument("[aliases...]", "repo aliases to fetch (omit for interactive multi-select)")
  .option("--all", "fetch every registered source repo")
  .option("--remote <name>", "remote to fetch (repeatable; omit to choose interactively)", collectRemote, [])
  .addHelpText("after", exitHelp)
  .action(async (aliases: string[], options: SourcesOptions & RemoteOptions) => {
    await exitWith(runManage("fetch", aliases, options));
  });

program
  .command("pull")
  .description(
    "Pull the submodule branch only (git pull --ff-only <remote>); never stages or commits the root gitlink (defaults to origin).",
  )
  .argument("[aliases...]", "repo aliases to pull (omit for interactive multi-select)")
  .option("--all", "pull every registered source repo")
  .option("--remote <name>", "remote to pull from (single; omit to choose interactively)", collectRemote, [])
  .addHelpText("after", `${pullHelp}${exitHelp}`)
  .action(async (aliases: string[], options: SourcesOptions & RemoteOptions) => {
    await exitWith(runManage("pull", aliases, options));
  });

program
  .command("push")
  .description(
    "Push the submodule branch only (creating the remote branch on first push); never stages or commits the root gitlink. Use \"oms record <alias>\" for root pointer commits (defaults to origin).",
  )
  .argument("<aliases...>", "repo aliases to push")
  .option("--commit", "unsupported: use \"oms record <alias>\" after pushing")
  .option("--record", "unsupported: use \"oms record <alias>\" after pushing")
  .option("--remote <name>", "remote to push to (repeatable; omit to choose interactively)", collectRemote, [])
  .addHelpText("after", `${pushHelp}${exitHelp}`)
  .action(async (aliases: string[], options: PushOptions & RemoteOptions) => {
    await exitWith(runManage("push", aliases, options));
  });

program
  .command("unsync")
  .description(
    `Deinitialize and remove the submodule for each alias (keeps ${MANIFEST_FILENAME} entry).`,
  )
  .argument("[aliases...]", "repo aliases to unsync (omit for interactive multi-select)")
  .option("--all", "unsync every registered source repo")
  .option("--force", "discard uncommitted changes in the submodule")
  .option("--commit", "create the root topology commit (chore(oms): remove ...) without prompting")
  .addHelpText("after", `${unsyncHelp}${exitHelp}`)
  .action(async (aliases: string[], options: UnsyncOptions) => {
    await exitWith(runUnsync(aliases, options));
  });

const agentCommand = program
  .command("agent")
  .description(`Manage OMS agent instruction blocks under ${DATA_DIRNAME}/ (AGENTS.md, CLAUDE.md).`)
  .addHelpText("after", exitHelp);

agentCommand
  .command("install")
  .description(`Install or refresh the marker-managed OMS instruction block in ${DATA_DIRNAME}/AGENTS.md and/or ${DATA_DIRNAME}/CLAUDE.md.`)
  .option("--target <target>", "agents | claude | both (omit to choose interactively)")
  .addHelpText("after", `${agentInstallHelp}${exitHelp}`)
  .action(async (options: AgentOptions) => {
    await exitWith(runAgentInstall(options));
  });

agentCommand
  .command("uninstall")
  .description(`Remove the marker-managed OMS instruction block from ${DATA_DIRNAME}/AGENTS.md and/or ${DATA_DIRNAME}/CLAUDE.md.`)
  .option("--target <target>", "agents | claude | both (omit to choose interactively)")
  .addHelpText("after", `${agentUninstallHelp}${exitHelp}`)
  .action(async (options: AgentOptions) => {
    await exitWith(runAgentUninstall(options));
  });

program
  .command("update")
  .description("Check for and safely update the oms CLI. Only confident global installs are updated automatically.")
  .option("--check", "check for an available update without mutating the installation")
  .option("--yes", "run a confirmed global update without prompting")
  .addHelpText("after", exitHelp)
  .action(async (options: UpdateOptions) => {
    await exitWith(runUpdate(options));
  });

const requestedCommand = process.argv[2];
if (requestedCommand && !requestedCommand.startsWith("-") && !commandNames.has(requestedCommand)) {
  console.error(`error: unknown command '${requestedCommand}'`);
  process.exit(1);
}

await program.parseAsync();
