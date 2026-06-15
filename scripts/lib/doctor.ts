import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { log } from "@clack/prompts";
import {
  GITIGNORE_ENTRY,
  MANIFEST_FILENAME,
  MIN_GIT_MAJOR,
  MIN_GIT_MINOR,
  PACKAGE_NAME,
} from "./constants.js";
import {
  moduleFilePath,
  normalizePath,
  packageRoot,
  readJson,
  runtimePlatform,
  testEnv,
} from "./env.js";
import {
  currentBranch,
  isGitRepo,
  isRegisteredSubmodule,
  parseGitVersion,
  isGitVersionSupported,
  aliasDir,
  submoduleInitialized,
  submodulePath,
} from "./git.js";
import { abortOnLegacyRenameAt, abortOnLegacyWorktree, emitLegacyRenameHintWalkUp, gitignoreIgnoresOms, loadRepos } from "./manifest.js";
import { pinState } from "./status.js";
import type { InstallContext, PackageManager, RuntimeEvidence, UpdateCommand } from "./types.js";

export function formatCommand(command: UpdateCommand): string {
  return [command.executable, ...command.args].join(" ");
}

export function globalUpdateCommand(manager: PackageManager): UpdateCommand {
  if (manager === "npm") return { executable: "npm", args: ["install", "-g", `${PACKAGE_NAME}@latest`] };
  if (manager === "pnpm") return { executable: "pnpm", args: ["add", "-g", `${PACKAGE_NAME}@latest`] };
  if (manager === "yarn") return { executable: "yarn", args: ["global", "add", `${PACKAGE_NAME}@latest`] };
  return { executable: "bun", args: ["add", "-g", `${PACKAGE_NAME}@latest`] };
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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

export function collectRuntimeEvidence(): RuntimeEvidence {
  const mocked = testEnv("OMS_TEST_RUNTIME_EVIDENCE");
  if (mocked !== undefined) return JSON.parse(mocked) as RuntimeEvidence;

  const modulePath = testEnv("OMS_TEST_MODULE_PATH") ?? moduleFilePath;
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

export function detectInstallContext(): InstallContext {
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

export async function runDoctor(): Promise<number> {
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
