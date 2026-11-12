import path from 'node:path';
import { AGENT_DIRECTORY_SEGMENTS, AGENT_FILE_SUFFIX, SKILL_DIRECTORY_SEGMENTS, SKILL_FILE_NAME } from '@momonga/runtime';
import type { CliFiles } from '../ports.ts';

export type TemplateKind = 'skill' | 'agent';

export type CreatedFile = { kind: 'created'; file: string } | { kind: 'exists'; file: string };

export type TemplateFiles = Pick<CliFiles, 'readTextIfPresent' | 'mkdirPrivate' | 'writeText'>;

export const templateFileOf = (home: string, kind: TemplateKind, name: string): string =>
  kind === 'skill' ? path.join(home, SKILL_DIRECTORY_SEGMENTS.native, name, SKILL_FILE_NAME) : path.join(home, AGENT_DIRECTORY_SEGMENTS, `${name}${AGENT_FILE_SUFFIX}`);

const TEMPLATE_BODIES: Readonly<Record<TemplateKind, { description: string; body: string }>> = {
  skill: { description: 'Say what this skill does and when to use it.', body: 'Write the steps of the skill here.' },
  agent: { description: 'Say what work to give this agent.', body: 'Write the instructions of the agent here.' },
};

export const templateTextOf = (kind: TemplateKind, name: string): string => {
  const { description, body } = TEMPLATE_BODIES[kind];
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
};

export const createFromTemplate = async (files: TemplateFiles, home: string, kind: TemplateKind, name: string): Promise<CreatedFile> => {
  const file = templateFileOf(home, kind, name);
  if ((await files.readTextIfPresent(file)) !== undefined) return { kind: 'exists', file };
  await files.mkdirPrivate(path.dirname(file));
  await files.writeText(file, templateTextOf(kind, name));
  return { kind: 'created', file };
};
