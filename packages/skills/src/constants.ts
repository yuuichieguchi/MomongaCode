import path from 'node:path';

export const SKILL_FILE_NAME = 'SKILL.md';

export const SKILL_DIRECTORY_SEGMENTS = {
  native: path.join('.momonga', 'skills'),
  crossClient: path.join('.agents', 'skills'),
} as const;

export const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(['.git', 'node_modules']);

export type SkillLimits = { maxDepth: number; maxDirectories: number; maxResources: number };

export const DEFAULT_SKILL_LIMITS: SkillLimits = { maxDepth: 4, maxDirectories: 2000, maxResources: 100 };

export const NAME_MAX_LENGTH = 64;

export const DESCRIPTION_MAX_LENGTH = 1024;

export { ACTIVATE_SKILL_TOOL_NAME } from '@momonga/protocol';

export const ACTIVATE_SKILL_TIMEOUT_MS = 10_000;
