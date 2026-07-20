import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";
import { run, tempWorkspace, writeSources, makeFakeNpx, skillsEnv, SKILL_KERNEL, SKILL_NAMES, readSkill, splitSkillFrontmatter } from "./helpers.js";
// --- oms skills (install command + published skill sources) ---



test("skills prints the project and global install commands", () => {
  const result = run(["skills"]);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /npx skills add divlook\/oh-my-space\/skills\b/); // project scope
  assert.match(output, /npx skills add divlook\/oh-my-space\/skills -g\b/); // global scope
});

test("skills --install delegates to npx skills add from the workspace root, forwarding extra args", () => {
  const ws = tempWorkspace();
  writeSources(ws);
  const sub = join(ws, "oms", "api", "sub");
  mkdirSync(sub, { recursive: true });
  const { bin, captureFile } = makeFakeNpx(ws);

  const result = run(["skills", "--install", "--skill", "oms-branch"], { cwd: sub, env: skillsEnv(bin) });
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const captured = JSON.parse(readFileSync(captureFile, "utf8"));
  assert.deepEqual(captured.args, ["skills", "add", "divlook/oh-my-space/skills", "--skill", "oms-branch"]);
  // Resolved to the workspace root, not the oms/<alias>/ subdir the command ran from.
  assert.equal(realpathSync(captured.cwd), realpathSync(ws));
});

test("skills --install returns the delegated process exit code", () => {
  const ws = tempWorkspace();
  writeSources(ws);
  const { bin } = makeFakeNpx(ws, { exit: 7 });
  const result = run(["skills", "--install"], { cwd: ws, env: skillsEnv(bin) });
  assert.equal(result.status, 7, result.stdout + result.stderr);
});

test("skills --install delegates the overridden executable the same args npx would receive", () => {
  const ws = tempWorkspace();
  writeSources(ws);
  const { bin, captureFile } = makeFakeNpx(ws);
  const result = run(["skills", "--install"], { cwd: ws, env: skillsEnv(bin) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const captured = JSON.parse(readFileSync(captureFile, "utf8"));
  assert.deepEqual(captured.args, ["skills", "add", "divlook/oh-my-space/skills"]);
});

test("skills --install outside a workspace without -g errors and points to the global install", () => {
  const dir = tempWorkspace(); // no oms.yaml
  const { bin, captureFile } = makeFakeNpx(dir);
  const result = run(["skills", "--install"], { cwd: dir, env: skillsEnv(bin) });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /npx skills add divlook\/oh-my-space\/skills -g/);
  assert.ok(!existsSync(captureFile), "delegation must not run outside a workspace without -g");
});

test("skills --install -g delegates even outside a workspace", () => {
  const dir = tempWorkspace(); // no oms.yaml
  const { bin, captureFile } = makeFakeNpx(dir);
  const result = run(["skills", "--install", "-g"], { cwd: dir, env: skillsEnv(bin) });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const captured = JSON.parse(readFileSync(captureFile, "utf8"));
  assert.deepEqual(captured.args, ["skills", "add", "divlook/oh-my-space/skills", "-g"]);
});

test("skills --install prints the manual command when delegation cannot execute", () => {
  const ws = tempWorkspace();
  writeSources(ws);
  const missing = join(ws, "no-such-npx-binary");
  const result = run(["skills", "--install"], { cwd: ws, env: skillsEnv(missing) });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /npx skills add divlook\/oh-my-space\/skills/);
});

test("skills help documents purpose, scope, and an example", () => {
  const result = run(["skills", "--help"]);
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 0, output);
  assert.match(output, /install the oms workspace skills/i);
  assert.match(output, /project scope/i);
  assert.match(output, /global/i);
  assert.match(output, /\$ oms skills/);
});





test("each oms skill is published with name/description frontmatter", () => {
  for (const name of SKILL_NAMES) {
    const { frontmatter } = splitSkillFrontmatter(readSkill(name));
    const data = parseYaml(frontmatter);
    assert.equal(typeof data.name, "string", `${name}: name must be a string`);
    assert.ok(data.name.length > 0, `${name}: name must be non-empty`);
    assert.equal(data.name, name, `${name}: frontmatter name must match its directory`);
    assert.equal(typeof data.description, "string", `${name}: description must be a string`);
    assert.ok(data.description.length > 0, `${name}: description must be non-empty`);
  }
});

test("the guardrail kernel is single-sourced into the marker block and every SKILL.md", () => {
  // The marker block is built from OMS_SCOPE_GUARDRAIL, so asserting the kernel against the live
  // marker output pins SKILL_KERNEL to the source constant; the skill checks then catch any drift.
  const ws = tempWorkspace();
  writeSources(ws);
  const result = run(["agent", "install", "--target", "agents"], { cwd: ws });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const marker = readFileSync(join(ws, "oms", "AGENTS.md"), "utf8");
  assert.ok(marker.includes(SKILL_KERNEL), "kernel must be a literal substring of the marker block");

  for (const name of SKILL_NAMES) {
    assert.ok(readSkill(name).includes(SKILL_KERNEL), `${name} must carry the kernel verbatim`);
  }
});

test("each SKILL.md is schema-stable and portable", () => {
  // Agent-specific slash command, e.g. " /foo" or "(/foo)" — not a path like oms/<alias>/.
  const SLASH_COMMAND = /(^|[\s(])\/[A-Za-z]/m;
  for (const name of SKILL_NAMES) {
    const { frontmatter, body } = splitSkillFrontmatter(readSkill(name));

    // schemaVersion is declared in the body (which the agent reads), not the frontmatter.
    assert.doesNotMatch(frontmatter, /schemaVersion/, `${name}: schemaVersion must not live in frontmatter`);
    assert.match(body, /schemaVersion/, `${name}: body must declare the schemaVersion it was written against`);

    // Field semantics defer to the version-matched authoritative source.
    assert.ok(body.includes("oms status --help"), `${name}: body must point to oms status --help`);

    // Portable: no agent-specific slash-command syntax.
    assert.doesNotMatch(body, SLASH_COMMAND, `${name}: body must not contain slash-command syntax`);

    // Any normal-path flag a body names must cite the matching --help.
    if (body.includes("--commit")) {
      assert.ok(
        body.includes("oms sync --help") && body.includes("oms unsync --help"),
        `${name}: a body naming --commit must also cite oms sync --help and oms unsync --help`,
      );
    }
    if (/(^|[\s(`])-m\b/.test(body)) {
      assert.ok(body.includes("oms commit --help"), `${name}: a body naming -m must also cite oms commit --help`);
    }
  }
});
