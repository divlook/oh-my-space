import semver from "semver";
import { formatCommand, packageInstallCommand } from "./package-install.js";
import type { PackageManager } from "./package-install.js";

export type RegistryDistTags = { latest: string; beta: string | null };

function registryDistTagsObject(data: unknown, policy: "latest" | "channels"): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data) || (policy === "channels" && !("dist-tags" in data))) {
    throw new Error(policy === "channels"
      ? "npm registry response was not a JSON object with dist-tags"
      : "npm registry response was not a JSON object");
  }
  const distTags = (data as { "dist-tags"?: unknown })["dist-tags"];
  if (!distTags || typeof distTags !== "object" || Array.isArray(distTags) || (policy === "channels" && !("latest" in distTags))) {
    throw new Error("npm registry response is missing dist-tags.latest");
  }
  return distTags as Record<string, unknown>;
}

/** Parses only the stable tag; semver validation remains in the update comparison. */
export function latestFromRegistryJson(data: unknown): string {
  const latest = registryDistTagsObject(data, "latest").latest;
  if (typeof latest !== "string" || latest.length === 0) {
    throw new Error("npm registry response is missing dist-tags.latest");
  }
  return latest;
}

export function registryDistTagsFromJson(data: unknown): RegistryDistTags {
  const distTags = registryDistTagsObject(data, "channels");
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

export function channelInstallCommand(manager: PackageManager, tag: "beta" | "latest"): string {
  return formatCommand(packageInstallCommand(manager, { tag }));
}
