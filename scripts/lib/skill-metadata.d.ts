export type ParsedSkillMetadata = {
  version: string | null;
  omsVersion: string | null;
};

export type SkillReference = {
  version: string;
  omsVersion: string;
};

export function skillCompatibilitySentence(omsVersion: string): string;
export function parseSkillMetadata(raw: string): ParsedSkillMetadata;
export function validatePublishedSkillMetadata(raw: string, skillPath: string): SkillReference;
