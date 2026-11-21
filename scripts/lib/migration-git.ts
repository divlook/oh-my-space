import { posix } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DATA_DIRNAME, MANIFEST_FILENAME } from "./constants.js";
import type { SourceWorkspace } from "./source-checkout.js";

type TreeEntry = { mode: string; oid: string; stage: string };
export type RootEntries = Map<string, TreeEntry[]>;
type RegistrationFields = Map<string, (string | null)[]>;
type Registration = { name: string; fields: RegistrationFields };
type SelectedRegistration = { fields: RegistrationFields; url: string };

export function rootEntries({ root, git }: SourceWorkspace, rev: string | null, paths = [DATA_DIRNAME, ".gitmodules", MANIFEST_FILENAME]): RootEntries {
  const result = git(root, rev ? ["ls-tree", "-rz", rev, "--", ...paths] : ["ls-files", "--stage", "-z", "--", ...paths]);
  if (!result.success) throw new Error(`could not inspect ${rev ? "root history" : "root index"}`);
  const files: RootEntries = new Map();
  for (const row of result.stdout.split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("\t");
    const match = /^(\d{6}) (?:blob |commit )?([0-9a-f]+)(?: ([0-3]))?$/.exec(row.slice(0, tab));
    if (!match || tab < 0) throw new Error("invalid root Git tree or index record");
    const name = row.slice(tab + 1);
    const entry = { mode: match[1], oid: match[2], stage: match[3] ?? "0" };
    const group = files.get(name);
    if (group) group.push(entry);
    else files.set(name, [entry]);
  }
  return files;
}

export function presentMigrationGitlinks(ws: SourceWorkspace, links: readonly { path: string; oid: string }[]): Set<string> {
  if (!links.length) return new Set();
  const all = new Map(links.map(({ path, oid }) => [path, oid]));
  const result = ws.git(ws.root, ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...all.keys()]);
  if (!result.success) throw new Error("could not inspect migration paths in the root index");
  const present = new Set<string>();
  for (const row of result.stdout.split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("\t");
    const path = row.slice(tab + 1);
    const expected = all.get(path);
    if (!expected || row.slice(0, tab) !== `160000 ${expected} 0` || present.has(path)) throw new Error(`root index entry changed for ${path}; preserve its staging and inspect before retrying`);
    present.add(path);
  }
  return present;
}

function readConfig({ root, git }: SourceWorkspace, args: string[], input?: Buffer) {
  // Latin-1 keeps each Git output byte distinct, including malformed UTF-8.
  return git(root, ["config", ...args, "--null", "--list"], input, "latin1");
}

function submoduleKey(row: string, separator = row.indexOf("\n")) {
  const key = separator < 0 ? row : row.slice(0, separator);
  return /^submodule\.(.+)\.([^.]+)$/.exec(key);
}

export function registrations(ws: SourceWorkspace, args: string[], input?: Buffer): Registration[] {
  const result = readConfig(ws, args, input);
  if (!result.success) throw new Error("could not read legacy Git configuration");
  const sections = new Map<string, Registration>();
  for (const row of result.stdout.split("\0")) {
    const separator = row.indexOf("\n");
    const match = submoduleKey(row, separator);
    if (!match) continue;
    const [, name, field] = match;
    let section = sections.get(name);
    if (!section) {
      section = { name, fields: new Map() };
      sections.set(name, section);
    }
    const value = separator < 0 ? null : row.slice(separator + 1);
    const values = section.fields.get(field);
    if (values) values.push(value);
    else section.fields.set(field, [value]);
  }
  return [...sections.values()];
}

export function blobRegistrations(ws: SourceWorkspace, tracked: RootEntries): Registration[] {
  const file = tracked.get(".gitmodules");
  if (!file) return [];
  if (file.length !== 1 || !/^100(644|755)$/.test(file[0].mode) || file[0].stage !== "0") {
    throw new Error(".gitmodules is not a regular, unconflicted file");
  }
  return registrations(ws, ["--blob", file[0].oid]);
}

export function registration(sections: Registration[], path: string): SelectedRegistration | undefined {
  const matches = sections.filter(({ name, fields }) => name === path ||
    fields.get("path")?.some((p) => p !== null && posix.normalize(p).replace(/\/+$/, "") === path));
  if (!matches.length) return undefined;
  const { name, fields } = matches[0];
  const paths = fields.get("path");
  const urls = fields.get("url");
  if (matches.length !== 1 || name !== path || paths?.length !== 1 || paths[0] !== path || urls?.length !== 1 || !urls[0]) {
    throw new Error(`${path} has ambiguous or non-OMS .gitmodules registration`);
  }
  return { fields, url: urls[0] };
}

export function registrationMatchesOrigin(registration: SelectedRegistration, origin: string): boolean {
  return registration.url === Buffer.from(origin).toString("latin1");
}

export function sameRegistration(expected: SelectedRegistration, current: SelectedRegistration | undefined): boolean {
  return isDeepStrictEqual(expected.fields, current?.fields);
}

export function verifyStagedRegistrations(ws: SourceWorkspace, baseline: Buffer, links: readonly { path: string }[]): void {
  const before = registrations(ws, ["--file", "-"], baseline);
  const staged = blobRegistrations(ws, rootEntries(ws, null, [".gitmodules"]));
  for (const { path } of links) {
    const expected = registration(before, path);
    if (!expected || !sameRegistration(expected, registration(staged, path))) {
      throw new Error(`staged .gitmodules registration changed for ${path}; preserve its staging and inspect before retrying`);
    }
  }
}

export function removeRegistrationSections(ws: SourceWorkspace, content: string, names: ReadonlySet<string>): string {
  const args = ["--no-includes", "--file", "-"];
  const before = readConfig(ws, args, Buffer.from(content));
  if (!before.success) throw new Error("could not verify Git configuration before removing legacy sections");
  const expected = before.stdout.split("\0").filter((row) => {
    const name = submoduleKey(row)?.[1];
    return name === undefined || !names.has(name);
  }).join("\0");
  const chunks: string[] = [];
  let remove = false;
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (/^\s*\[/.test(line)) {
      const name = /^\s*\[submodule\s+"([^"\\]+)"\s*\]/i.exec(line)?.[1];
      remove = name !== undefined && names.has(name);
      if (!remove) chunks.push(line);
    } else if (!remove || /^\s*(?:[;#]|$)/.test(line)) chunks.push(line);
  }
  const result = chunks.join("");
  const after = readConfig(ws, args, Buffer.from(result));
  if (!after.success || after.stdout !== expected) {
    throw new Error("legacy Git sections overlap an unsupported configuration format; preserve the file and simplify the affected sections before retrying");
  }
  return result;
}
