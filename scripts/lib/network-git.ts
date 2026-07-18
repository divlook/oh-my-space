import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "@clack/prompts";
import { runGit, redactSensitiveUrls } from "./git.js";
import { validateWorktreeRemoteUrl } from "./manifest.js";
import type { GitResult, Repo } from "./types.js";

type ConfigEntry = { key: string; value: string };
type NetworkSnapshot = { env: NodeJS.ProcessEnv; endpoint: string };
type NetworkGitResult = GitResult & { fallbackTrusted: boolean; capturedOid: string | null };

export class NetworkSafetyError extends Error {}

const ALLOWED_CONFIG = /^(?:credential(?:\.|$)|http(?:\.|$)|core\.sshcommand$|protocol\.[a-z0-9+.-]+\.allow$)/i;

function withoutConfigInjection(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_CONFIG_")));
}

function parseConfigList(value: string): ConfigEntry[] {
  return value.split("\0").filter(Boolean).flatMap((entry) => {
    const separator = entry.indexOf("\n");
    if (separator < 1) return [];
    return [{ key: entry.slice(0, separator), value: entry.slice(separator + 1) }];
  });
}

function readAllowedConfig(common: string, scope: "--system" | "--global", baseEnv: NodeJS.ProcessEnv): ConfigEntry[] {
  const result = spawnSync("git", ["config", scope, "--includes", "-z", "--list"], {
    cwd: common,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...baseEnv, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.status !== 0) return [];
  return parseConfigList(result.stdout).filter(({ key }) => ALLOWED_CONFIG.test(key));
}

function endpointProtocol(endpoint: string): string | null {
  if (/^[a-z]:[\\/]/i.test(endpoint)) return "file";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) && /^(?:[^/@:\s]+@)?[^/:\s]+:.+$/.test(endpoint)) return "ssh";
  try {
    const protocol = new URL(endpoint).protocol.replace(/:$/, "").toLowerCase();
    return protocol || null;
  } catch {
    return endpoint.startsWith("/") || endpoint.startsWith("./") || endpoint.startsWith("../") ? "file" : null;
  }
}

function immutableNetworkEnv(common: string, endpoint: string): NodeJS.ProcessEnv {
  const base = withoutConfigInjection();
  const allowed = [...readAllowedConfig(common, "--system", base), ...readAllowedConfig(common, "--global", base)];
  const protocol = endpointProtocol(endpoint);
  if (protocol === "file" && !allowed.some(({ key }) => key.toLowerCase() === "protocol.file.allow")) {
    allowed.push({ key: "protocol.file.allow", value: "always" });
  }
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: String(allowed.length),
    GIT_OPTIONAL_LOCKS: "0",
  };
  allowed.forEach(({ key, value }, index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  if (protocol) env.GIT_ALLOW_PROTOCOL = protocol;
  return env;
}

function rejectLocalUrlRewrites(common: string): void {
  const result = spawnSync("git", ["config", "--local", "--get-regexp", "^url\\..*\\.(insteadOf|pushInsteadOf)$"], {
    cwd: common,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...withoutConfigInjection(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    },
  });
  if (result.status === 0 && result.stdout.trim()) {
    throw new NetworkSafetyError("local Git URL rewrite configuration is not allowed for managed network operations");
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error("could not inspect local Git URL rewrite configuration");
  }
}

function exactGit(cwd: string, args: string[], env: NodeJS.ProcessEnv, inheritOutput: boolean): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: inheritOutput ? ["inherit", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    env,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (inheritOutput) {
    if (stdout) process.stdout.write(redactSensitiveUrls(stdout));
    if (stderr) process.stderr.write(redactSensitiveUrls(stderr));
  }
  return { exitCode: result.status, success: result.status === 0, stdout: inheritOutput ? "" : stdout, stderr: inheritOutput ? "" : stderr };
}

function networkSnapshot(common: string, repo: Repo, remote: string, push: boolean): NetworkSnapshot {
  const declared = repo.remotes[remote];
  if (!declared) throw new NetworkSafetyError(`${repo.alias}: remote "${remote}" is not declared in oms.yaml`);
  try {
    validateWorktreeRemoteUrl(declared, `repository ${repo.alias} remote ${remote}`);
  } catch (error) {
    throw new NetworkSafetyError(error instanceof Error ? error.message : String(error));
  }
  rejectLocalUrlRewrites(common);
  const env = immutableNetworkEnv(common, declared);
  const resolved = exactGit(common, ["remote", "get-url", ...(push ? ["--push"] : []), remote], env, false);
  const endpoint = resolved.stdout.trim();
  if (!resolved.success || !endpoint) throw new Error(`${repo.alias}: could not resolve effective endpoint for ${remote}`);
  try {
    validateWorktreeRemoteUrl(endpoint, `effective repository ${repo.alias} remote ${remote}`);
  } catch (error) {
    throw new NetworkSafetyError(error instanceof Error ? error.message : String(error));
  }
  if (endpoint !== declared) throw new NetworkSafetyError(`${repo.alias}: effective endpoint for ${remote} differs from oms.yaml`);
  return { env, endpoint };
}

/** Run one network Git operation under an immutable validated endpoint snapshot. */
export function runNetworkGit(
  common: string,
  repo: Repo,
  remote: string,
  args: (endpoint: string) => string[],
  options: {
    push?: boolean;
    inheritOutput?: boolean;
    checkFallback?: () => boolean;
    captureOid?: () => string | null;
    onSuccess?: () => void;
  } = {},
): NetworkGitResult {
  const configLock = join(common, "config.lock");
  let lockFd: number;
  try {
    lockFd = openSync(configLock, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      let owner = "";
      try {
        const value = JSON.parse(readFileSync(configLock, "utf8")) as { omsNetworkConfigLock?: number; pid?: number };
        if (value.omsNetworkConfigLock === 1 && typeof value.pid === "number") owner = ` by OMS process ${value.pid}`;
      } catch {
        // A normal Git config lock is not JSON and remains an external ownership boundary.
      }
      throw new NetworkSafetyError(
        `${repo.alias}: common repository config is locked${owner}. If no Git or OMS process is active, inspect and remove only ${configLock}, then retry.`,
      );
    }
    throw error;
  }
  try {
    writeFileSync(lockFd, `${JSON.stringify({ omsNetworkConfigLock: 1, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    fsyncSync(lockFd);
    const snapshot = networkSnapshot(common, repo, remote, Boolean(options.push));
    const result = exactGit(common, args(snapshot.endpoint), snapshot.env, Boolean(options.inheritOutput));
    const fallbackTrusted = !result.success && (options.checkFallback?.() ?? false);
    const capturedOid = (result.success || fallbackTrusted) ? options.captureOid?.() ?? null : null;
    if (result.success) options.onSuccess?.();
    return {
      ...result,
      fallbackTrusted,
      capturedOid,
    };
  } finally {
    closeSync(lockFd);
    rmSync(configLock, { force: true });
  }
}

/** Report a network policy failure without exposing endpoint credentials. */
export function networkFailure(repo: Repo, remote: string, error: unknown): void {
  const reason = redactSensitiveUrls(error instanceof Error ? error.message : String(error));
  log.error(`${repo.alias}: ${remote} network policy failed: ${reason}`);
}
