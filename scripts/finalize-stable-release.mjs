import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import semver from "semver";
import { PACKAGE_NAME } from "./lib/package-info.js";

const repository = "divlook/oh-my-space";
const registry = "https://registry.npmjs.org";
const apiRoot = `repos/${repository}`;
let phase = "input validation";
let version;
let commit;

try {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      commit: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log("Usage: node scripts/finalize-stable-release.mjs [--version <stable-version> --commit <full-sha>]\n\nCompletes GitHub metadata only; never publishes npm packages or changes dist-tags.\nDefaults to the current package version and its verified npm gitHead.\nRequires main history and authenticated GitHub CLI with contents-write access.");
  } else {
    if ((values.version !== undefined) !== (values.commit !== undefined)) {
      throw new Error("Historical recovery requires both --version and --commit.");
    }
    if (values.version !== undefined) {
      version = values.version;
      commit = values.commit;
    } else {
      const current = JSON.parse(readFileSync("package.json", "utf8"));
      if (current.name !== PACKAGE_NAME) throw new Error(`Expected package ${PACKAGE_NAME}.`);
      version = current.version;
    }
    if (semver.valid(version) !== version || semver.prerelease(version) !== null) {
      throw new Error(`Expected an exact stable version, received ${JSON.stringify(version)}.`);
    }
    if (commit !== undefined && !/^[0-9a-f]{40}$/.test(commit)) {
      throw new Error("Expected --commit to be a full lowercase 40-character Git SHA.");
    }

    phase = "npm publication verification";
    const published = JSON.parse(run("npm", [
      "view", `${PACKAGE_NAME}@${version}`, "name", "version", "gitHead", "--json", "--registry", registry,
    ]));
    if (published.name !== PACKAGE_NAME || published.version !== version || !/^[0-9a-f]{40}$/.test(published.gitHead ?? "")) {
      throw new Error("npm metadata must identify the exact package, version, and published gitHead.");
    }
    if (commit !== undefined && published.gitHead !== commit) {
      throw new Error(`Requested commit ${commit} differs from npm gitHead ${published.gitHead}.`);
    }
    commit = published.gitHead;

    phase = "source history verification";
    if (git("rev-parse", "--verify", `${commit}^{commit}`) !== commit) {
      throw new Error(`Published commit ${commit} is not a local commit.`);
    }
    const remoteMain = invoke("git", ["show-ref", "--verify", "--quiet", "refs/remotes/origin/main"]);
    if (remoteMain.status !== 0 && remoteMain.status !== 1) requireSuccess(remoteMain, "Read origin/main");
    const main = remoteMain.status === 0 ? "refs/remotes/origin/main" : "refs/heads/main";
    git("rev-parse", "--verify", `${main}^{commit}`);
    const ancestor = invoke("git", ["merge-base", "--is-ancestor", commit, main]);
    requireSuccess(ancestor, `Published commit ${commit} must belong to ${main}`);
    const historical = JSON.parse(git("show", `${commit}:package.json`));
    if (historical.name !== PACKAGE_NAME || historical.version !== version) {
      throw new Error("Published commit does not contain the requested package version.");
    }
    const changelog = git("show", `${commit}:CHANGELOG.md`);
    const lines = changelog.split(/\r?\n/);
    const start = lines.findIndex((line) => line.trim() === `## ${version}`);
    if (start === -1) throw new Error(`Missing changelog entry for ${version} at ${commit}.`);
    const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
    const notes = lines.slice(start + 1, next === -1 ? undefined : next).join("\n").trim();
    if (!notes) throw new Error(`Empty changelog entry for ${version} at ${commit}.`);

    phase = "GitHub metadata preflight";
    const repo = api("GET", apiRoot);
    if (repo.full_name !== repository) throw new Error(`Expected GitHub repository ${repository}.`);
    const tag = `v${version}`;
    const tagEndpoint = `${apiRoot}/git/ref/tags/${encodeURIComponent(tag)}`;
    const releaseEndpoint = `${apiRoot}/releases/tags/${encodeURIComponent(tag)}`;
    const existingTag = api("GET", tagEndpoint, undefined, true);
    const existingRelease = api("GET", releaseEndpoint, undefined, true);
    if (existingTag !== null) verifyTag(existingTag);
    if (existingRelease !== null) verifyRelease(existingRelease, tag);

    phase = "remote tag creation";
    if (existingTag === null) {
      api("POST", `${apiRoot}/git/refs`, { ref: `refs/tags/${tag}`, sha: commit });
    }
    verifyTag(api("GET", tagEndpoint));

    phase = "GitHub Release creation";
    if (existingRelease === null) {
      api("POST", `${apiRoot}/releases`, {
        tag_name: tag,
        target_commitish: commit,
        name: tag,
        body: notes,
        draft: false,
        prerelease: false,
        make_latest: "legacy",
      });
    }
    phase = "remote completion verification";
    verifyTag(api("GET", tagEndpoint));
    const release = api("GET", releaseEndpoint);
    verifyRelease(release, tag);
    console.log(`Completed ${PACKAGE_NAME}@${version}: ${tag} -> ${commit}`);
    console.log(release.html_url);
  }
} catch (error) {
  console.error(`Stable release finalization failed during ${phase}: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Published npm packages and completed remote metadata are preserved; no rollback was attempted.");
  if (typeof version === "string" && semver.valid(version) === version && semver.prerelease(version) === null) {
    const recoveryCommit = /^[0-9a-f]{40}$/.test(commit ?? "")
      ? commit
      : `"$(npm view ${PACKAGE_NAME}@${version} gitHead --registry ${registry})"`;
    console.error(`Metadata-only recovery: node scripts/finalize-stable-release.mjs --version ${version} --commit ${recoveryCommit}`);
  } else {
    console.error("Recovery input guidance: node scripts/finalize-stable-release.mjs --help");
  }
  process.exitCode = 1;
}

function invoke(command, args, input) {
  return spawnSync(command, args, { encoding: "utf8", input, maxBuffer: 8 * 1024 * 1024 });
}

function requireSuccess(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${operation}: ${(result.stderr || result.stdout || `exit ${result.status}, signal ${result.signal}`).trim()}`);
  }
  return result.stdout;
}

function run(command, args) {
  return requireSuccess(invoke(command, args), `${command} ${args.join(" ")}`).trim();
}

function git(...args) {
  return run("git", args);
}

function api(method, endpoint, body, allowMissing = false) {
  const args = ["api", "--hostname", "github.com", "--method", method, endpoint];
  if (body !== undefined) args.push("--input", "-");
  const result = invoke("gh", args, body === undefined ? undefined : JSON.stringify(body));
  if (allowMissing && !result.error && result.status !== 0 && /\(HTTP 404\)/.test(result.stderr)) return null;
  return JSON.parse(requireSuccess(result, `GitHub ${method} ${endpoint}`));
}

function verifyTag(ref) {
  let object = ref.object;
  const seen = new Set();
  while (object?.type === "tag") {
    if (seen.has(object.sha)) throw new Error("Cyclic annotated tag response.");
    seen.add(object.sha);
    object = api("GET", `${apiRoot}/git/tags/${object.sha}`).object;
  }
  if (object?.type !== "commit" || object.sha !== commit) {
    throw new Error(`Remote version tag does not resolve to published commit ${commit}; refusing to move it.`);
  }
}

function verifyRelease(release, tag) {
  if (release.tag_name !== tag || release.draft !== false || release.prerelease !== false) {
    throw new Error(`Existing Release for ${tag} is incompatible; refusing to overwrite it.`);
  }
}
