import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawGitRunner } from "./git.js";

const oidPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

type LocalRef = { name: string; oid: string; upstream: string; remote: string };
export type RemovalHistory = { head: string; refs: LocalRef[]; reflogOnly: string[]; objectFormat: string };
export type OriginProof = { kind: "verified"; refs: string } | { kind: "inaccessible" };

export function readRemovalHistory(git: RawGitRunner, checkout: string): RemovalHistory {
  const refResult = git(checkout, ["--no-replace-objects", "for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)%00%(upstream:remotename)"]);
  const head = git(checkout, ["--no-replace-objects", "rev-parse", "--verify", "HEAD^{commit}"]);
  const reflog = git(checkout, ["--no-replace-objects", "rev-list", "--reflog", "--not", "--all", "HEAD"]);
  const format = git(checkout, ["rev-parse", "--show-object-format"]);
  if ([refResult, head, reflog, format].some((result) => !result.success || result.stderr.trim())) {
    throw new Error("could not inspect all local refs, HEAD, and reflog history");
  }
  const refs = refResult.stdout.trimEnd().split("\n").filter(Boolean).map((line) => {
    const [name, oid, upstream, remote] = line.split("\0");
    if (!name.startsWith("refs/") || !oidPattern.test(oid) || upstream === undefined || remote === undefined) {
      throw new Error("could not decode a local Git ref");
    }
    return { name, oid, upstream, remote };
  });
  const reflogOnly = reflog.stdout.trim().split("\n").filter(Boolean);
  const objectFormat = format.stdout.trim();
  if (!oidPattern.test(head.stdout.trim()) || reflogOnly.some((oid) => !oidPattern.test(oid)) ||
      (objectFormat !== "sha1" && objectFormat !== "sha256")) throw new Error("could not verify local object identities");
  return { head: head.stdout.trim(), refs, reflogOnly, objectFormat };
}

export function describeRemovalRefs(history: RemovalHistory): string {
  const branches: string[] = [];
  const tags: string[] = [];
  for (const { name } of history.refs) {
    if (name.startsWith("refs/heads/")) branches.push(name.slice("refs/heads/".length));
    else if (name.startsWith("refs/tags/")) tags.push(name.slice("refs/tags/".length));
  }
  return `branches: ${branches.join(", ") || "none"}; tags: ${tags.join(", ") || "none"}`;
}

function parseRefs(output: string): Map<string, string> {
  const refs = new Map<string, string>();
  for (const line of output.trimEnd().split("\n")) {
    if (!line) continue;
    const [oid, name] = line.split("\t");
    if (!oidPattern.test(oid) || !name?.startsWith("refs/") || refs.has(name)) throw new Error("could not verify current origin refs");
    refs.set(name, oid);
  }
  return refs;
}

export function verifyOriginHistory(git: RawGitRunner, checkout: string, origin: string, history: RemovalHistory): OriginProof {
  const remote = git(checkout, ["ls-remote", "--refs", "--", "origin"]);
  if (!remote.success) {
    if (remote.exitCode === null) throw new Error("Git could not inspect the origin");
    return { kind: "inaccessible" };
  }
  const advertised = parseRefs(remote.stdout);
  for (const { name, oid } of history.refs) {
    if (name.startsWith("refs/tags/") && advertised.get(name) !== oid) {
      throw new Error(`tag ${name.slice("refs/tags/".length)} is absent or has a different object at origin`);
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), "oms-origin-"));
  try {
    const dir = `--git-dir=${scratch}`;
    if (!git(checkout, [dir, "init", "--bare", "--template=", `--object-format=${history.objectFormat}`]).success) {
      throw new Error("could not create an isolated repository for origin verification");
    }
    if (advertised.size) {
      const fetched = git(checkout, [dir, "-c", `remote.oms-probe.url=${origin}`, "-c", "fetch.fsckObjects=true", "fetch", "--no-tags", "--no-write-fetch-head", "--", "oms-probe", "+refs/*:refs/oms-origin/*"]);
      if (!fetched.success) throw new Error("origin responded but its current objects could not be verified");
    }
    const copied = git(checkout, [dir, "for-each-ref", "--format=%(objectname)%09%(refname)", "refs/oms-origin/"]);
    if (!copied.success) throw new Error("could not read the isolated origin refs");
    const snapshot = parseRefs(copied.stdout);
    if (snapshot.size !== advertised.size || [...advertised].some(([name, oid]) => snapshot.get(`refs/oms-origin/${name.slice(5)}`) !== oid)) {
      throw new Error("origin refs changed during verification; retry before removing the checkout");
    }
    // Check only commits reachable from actual fetched refs, never the source's cached refs.
    // Refs can point to blobs or trees; exclude those from the commit ancestry walk.
    const remoteCommits = new Set<string>();
    for (const name of snapshot.keys()) {
      const peeled = git(checkout, [dir, "--no-replace-objects", "rev-parse", "--quiet", "--verify", `${name}^{commit}`]);
      if (peeled.success) remoteCommits.add(peeled.stdout.trim());
    }
    const negative = [...remoteCommits].map((oid) => `^${oid}\n`).join("");
    const checked = new Set<string>();
    const prove = (oid: string, label: string) => {
      if (checked.has(oid)) return;
      const r = git(checkout, [dir, "--no-replace-objects", "rev-list", "--max-count=1", "--stdin"], Buffer.from(`${oid}\n${negative}`));
      if (!r.success || r.stderr || r.stdout) throw new Error(`${label} (${oid}) is not proven recoverable from current origin refs. Preserve it outside the checkout before retrying.`);
      checked.add(oid);
    };
    for (const oid of history.reflogOnly) prove(oid, "reflog-only commit");
    prove(history.head, "HEAD");
    for (const { name, oid } of history.refs) {
      if (name.startsWith("refs/tags/")) continue;
      if ([...advertised.values()].includes(oid)) continue;
      prove(oid, name);
    }
    return { kind: "verified", refs: remote.stdout };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
