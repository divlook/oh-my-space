import assert from "node:assert/strict";
import test from "node:test";
import {
  agentInstallHelp,
  commitHelp,
  recordHelp,
  skillsHelp,
  statusHelp,
  syncHelp,
  unsyncHelp,
} from "../../scripts/lib/help.js";
import { resolveRemotes, selectRepos } from "../../scripts/lib/prompts.js";
import type { Repo } from "../../scripts/lib/types.js";

const repos: Repo[] = [
  { alias: "api", remotes: { origin: "https://example.com/api.git", backup: "ssh://backup/api.git" }, branch: "main" },
  { alias: "web", remotes: { origin: "https://example.com/web.git" } },
];

test("command help states scope boundaries and runnable examples", () => {
  assert.match(statusHelp, /schemaVersion 1/);
  assert.match(statusHelp, /oms status api --json/);
  assert.match(commitHelp, /submodule only — never the root gitlink/);
  assert.match(commitHelp, /oms commit api -m/);
  assert.match(recordHelp, /ROOT repository only/);
  assert.match(recordHelp, /oms record --all/);
  assert.match(syncHelp, /oms sync/);
  assert.match(unsyncHelp, /oms unsync/);
  assert.match(agentInstallHelp, /oms agent install/);
  assert.match(skillsHelp, /oms skills/);
});

test("explicit repository selection preserves manifest order for all and user order for aliases", async () => {
  assert.deepEqual(await selectRepos(repos, [], { all: true }, "fetch"), repos);
  assert.deepEqual((await selectRepos(repos, ["web", "api", "web"], {}, "fetch"))?.map((repo) => repo.alias), ["web", "api"]);
});

test("remote selection deduplicates explicit targets and defaults non-interactive selection to origin", async () => {
  assert.deepEqual(await resolveRemotes(repos[0], ["backup", "origin", "backup"], "fetch"), ["backup", "origin"]);
  assert.deepEqual(await resolveRemotes(repos[0], undefined, "push"), ["origin"]);
  assert.deepEqual(await resolveRemotes(repos[1], undefined, "pull"), ["origin"]);
});
