import { ACTIVATE_SKILL_TOOL_NAME } from './constants.ts';
import { escapeText } from './xml.ts';
import type { Skill } from './types.ts';

const oneLine = (value: string): string => value.replace(/\s+/g, ' ');

export const renderCatalog = (skills: readonly Skill[]): string | undefined => {
  if (skills.length === 0) return undefined;
  return [
    'The following skills provide specialized instructions for specific tasks.',
    `When a task matches a skill's description, call the ${ACTIVATE_SKILL_TOOL_NAME} tool with the skill's name to load its full instructions.`,
    '',
    '<available_skills>',
    ...skills.flatMap((skill) => [
      '  <skill>',
      `    <name>${escapeText(skill.name)}</name>`,
      `    <description>${escapeText(oneLine(skill.description))}</description>`,
      '  </skill>',
    ]),
    '</available_skills>',
  ].join('\n');
};
