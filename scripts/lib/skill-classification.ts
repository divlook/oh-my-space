import semver from "semver";
import type { SkillReference } from "./skill-metadata.js";
import type { InstalledSkill, SkillFinding } from "./skill-discovery.js";

export type SkillFreshness = "current" | "older" | "newer" | "unverified";
export type SkillCompatibility = "compatible" | "incompatible" | "unverified";

export function classifyFreshness(installed: string | null, current: string, located = true): SkillFreshness {
  if (!located) return "unverified";
  if (installed === null) return "older";
  const comparison = semver.compare(installed, current);
  if (comparison === 0) return "current";
  return comparison > 0 ? "newer" : "older";
}

export function classifyCompatibility(omsVersion: string | null, runningVersion: string): SkillCompatibility {
  if (omsVersion === null || !semver.valid(runningVersion)) return "unverified";
  return semver.satisfies(runningVersion, omsVersion) ? "compatible" : "incompatible";
}

export function classifySkillMetadata(
  installedVersion: string | null,
  referenceVersion: string,
  installedOmsVersion: string | null,
  runningVersion: string,
  located = true,
): { freshness: SkillFreshness; compatibility: SkillCompatibility } {
  return {
    freshness: classifyFreshness(installedVersion, referenceVersion, located),
    compatibility: classifyCompatibility(installedOmsVersion, runningVersion),
  };
}

export function classifyInstalledSkills(installations: InstalledSkill[], references: Record<string, SkillReference>, runningVersion: string): SkillFinding[] {
  const findings: SkillFinding[] = [];

  for (const name of Object.keys(references).sort()) {
    const reference = references[name];
    if (!reference || !semver.valid(reference.version)) continue;

    const grouped = new Map<string, SkillFinding>();
    for (const installation of installations.filter((entry) => entry.name === name)) {
      const { path: skillPath, metadata } = installation;
      const { freshness, compatibility } = classifySkillMetadata(
        metadata.version,
        reference.version,
        metadata.omsVersion,
        runningVersion,
        skillPath !== null,
      );
      if (freshness === "current" && compatibility === "compatible") continue;

      const key = `${freshness}:${compatibility}:${metadata.version ?? ""}:${metadata.omsVersion ?? ""}`;
      const existing = grouped.get(key);
      if (existing) existing.scopes.push(installation.scope);
      else {
        grouped.set(key, {
          name,
          freshness,
          compatibility,
          installedVersion: metadata.version,
          installedOmsVersion: metadata.omsVersion,
          reference,
          scopes: [installation.scope],
        });
      }
    }
    findings.push(...grouped.values());
  }
  return findings;
}

