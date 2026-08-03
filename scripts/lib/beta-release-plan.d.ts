export type ReleasePlanInput = { releases?: unknown } | null | undefined;

export function selectBetaBaseVersion(releasePlan: ReleasePlanInput, currentVersion: string): string;
