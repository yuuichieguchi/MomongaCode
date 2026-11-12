export const SKILL_FILE_NAME = 'SKILL.md';

export const SKILL_FOLDER_PARTS = { native: ['.momonga', 'skills'], crossClient: ['.agents', 'skills'] } as const;

export const SKILL_NAME_MAX_LENGTH = 64;

const VALID_SKILL_NAME = /^(?!-)(?!.*--)[\p{Ll}\p{Nd}-]+(?<!-)$/u;

export const isValidSkillName = (name: string): boolean => name.length <= SKILL_NAME_MAX_LENGTH && VALID_SKILL_NAME.test(name);

export const AGENT_FOLDER_PARTS = ['.momonga', 'agents'] as const;

export const AGENT_FILE_SUFFIX = '.md';
