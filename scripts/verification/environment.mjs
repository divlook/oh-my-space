import { execFileSync } from "node:child_process";
import { arch, release, type } from "node:os";

const EMPTY_GIT_CONFIG = process.platform === "win32" ? "NUL" : "/dev/null";

/** Creates the deterministic environment inherited by canonical test processes. */
export function normalizedTestEnvironment(overrides = {}) {
  const env = { ...process.env };
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "GIT_ASKPASS",
    "GIT_SSH",
    "GIT_SSH_COMMAND",
    "SSH_ASKPASS",
  ]) {
    delete env[key];
  }

  Object.assign(env, {
    CI: "1",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: EMPTY_GIT_CONFIG,
    GIT_CONFIG_GLOBAL: EMPTY_GIT_CONFIG,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_COUNT: "6",
    GIT_CONFIG_KEY_0: "protocol.file.allow",
    GIT_CONFIG_VALUE_0: "always",
    GIT_CONFIG_KEY_1: "commit.gpgSign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_CONFIG_KEY_2: "tag.gpgSign",
    GIT_CONFIG_VALUE_2: "false",
    GIT_CONFIG_KEY_3: "user.email",
    GIT_CONFIG_VALUE_3: "test@example.com",
    GIT_CONFIG_KEY_4: "user.name",
    GIT_CONFIG_VALUE_4: "Test",
    GIT_CONFIG_KEY_5: "core.hooksPath",
    GIT_CONFIG_VALUE_5: EMPTY_GIT_CONFIG,
  });
  return Object.assign(env, overrides);
}

/** Collects the exact runtime identity bound to a local verification record. */
export function collectEnvironmentIdentity({ cwd = process.cwd(), env = normalizedTestEnvironment() } = {}) {
  const gitVersion = execFileSync("git", ["--version"], { cwd, env, encoding: "utf8" }).trim();
  return {
    node: process.version,
    git: gitVersion,
    os: type(),
    osVersion: release(),
    arch: arch(),
  };
}
