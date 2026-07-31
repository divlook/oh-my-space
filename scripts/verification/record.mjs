import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { VERIFICATION_RECORD_PATH, VERIFICATION_SCHEMA_VERSION } from "./config.mjs";

function isIdentity(value) {
  return value && typeof value === "object"
    && ["node", "git", "os", "osVersion", "arch"].every((key) => typeof value[key] === "string");
}

/** Creates the exact key for a content fingerprint and runtime identity. */
export function verificationKey(fingerprint, environment) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ fingerprint, environment }));
  return hash.digest("hex");
}

/** Parses a verification record, returning null for any malformed or unsupported input. */
export function parseVerificationRecord(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || value.schema !== VERIFICATION_SCHEMA_VERSION) return null;
    if (typeof value.key !== "string" || typeof value.fingerprint !== "string") return null;
    if (!isIdentity(value.environment) || typeof value.verifiedAt !== "string" || typeof value.command !== "string") return null;
    if (verificationKey(value.fingerprint, value.environment) !== value.key) return null;
    return value;
  } catch {
    return null;
  }
}

/** Reads the latest worktree-local verification record. */
export function readVerificationRecord(root) {
  try {
    return parseVerificationRecord(readFileSync(resolve(root, VERIFICATION_RECORD_PATH), "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    return null;
  }
}

/** Writes the latest successful record atomically. */
export function writeVerificationRecord(root, { fingerprint, environment, command = "npm test", verifiedAt = new Date().toISOString() }) {
  const record = {
    schema: VERIFICATION_SCHEMA_VERSION,
    key: verificationKey(fingerprint, environment),
    fingerprint,
    environment,
    verifiedAt,
    command,
  };
  const target = resolve(root, VERIFICATION_RECORD_PATH);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return record;
}

/** Removes the latest record only when it matches the rejected key. */
export function invalidateVerificationRecord(root, expectedKey) {
  const record = readVerificationRecord(root);
  if (!record || record.key !== expectedKey) return false;
  rmSync(resolve(root, VERIFICATION_RECORD_PATH), { force: true });
  return true;
}

/** Returns whether a parsed record exactly matches the current verification inputs. */
export function recordMatches(record, fingerprint, environment) {
  return record?.key === verificationKey(fingerprint, environment);
}
