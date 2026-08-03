import semver from "semver";
import { PACKAGE_NAME } from "./constants.js";
import type { PackageManager } from "./types.js";

export type RegistryDistTags = { latest: string; beta: string | null };

/** Parses the stable and beta npm dist-tags used for compatibility decisions. */
export function registryDistTagsFromJson(data: unknown): RegistryDistTags {
  if (!data || typeof data !== "object" || Array.isArray(data) || !("dist-tags" in data)) {
    throw new Error("npm registry response was not a JSON object with dist-tags");
  }
  const distTags = data["dist-tags"];
  if (!distTags || typeof distTags !== "object" || Array.isArray(distTags) || !("latest" in distTags)) {
    throw new Error("npm registry response is missing dist-tags.latest");
  }
  const latest = distTags.latest;
  if (typeof latest !== "string" || !semver.valid(latest)) {
    throw new Error("npm registry response has an invalid dist-tags.latest");
  }

  const beta = "beta" in distTags ? distTags.beta : null;
  if (beta !== null && (typeof beta !== "string" || !semver.valid(beta))) {
    throw new Error("npm registry response has an invalid dist-tags.beta");
  }
  return { latest, beta };
}

/** Formats a package-manager-specific global install command for an npm channel. */
export function channelInstallCommand(manager: PackageManager, tag: "beta" | "latest"): string {
  if (manager === "npm") return `npm install -g ${PACKAGE_NAME}@${tag}`;
  if (manager === "pnpm") return `pnpm add -g ${PACKAGE_NAME}@${tag}`;
  if (manager === "yarn") return `yarn global add ${PACKAGE_NAME}@${tag}`;
  return `bun add -g ${PACKAGE_NAME}@${tag}`;
}
