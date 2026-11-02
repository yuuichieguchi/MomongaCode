import type { RuntimeClient } from '../client/runtime-client.ts';
import { parseSlash } from '../tui/slash.ts';

export class SkillInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillInvocationError';
  }
}

export type SkillInvocation = { input: string; skill?: string };

export const skillTask = (name: string, args: string): SkillInvocation => {
  if (args === '') throw new SkillInvocationError(`/${name} needs a task to run the skill on: /${name} <task>`);
  return { input: args, skill: name };
};

export const skillInvocationOf = (prompt: string, skillNames: readonly string[]): SkillInvocation => {
  const parsed = parseSlash(prompt);
  if (parsed === undefined || !skillNames.includes(parsed.name)) return { input: prompt };
  return skillTask(parsed.name, parsed.args);
};

export const resolveSkillInvocation = async (
  client: Pick<RuntimeClient, 'skills'>,
  sessionId: string,
  prompt: string,
  explicitSkill: string | undefined,
): Promise<SkillInvocation> => {
  if (explicitSkill !== undefined) {
    const { skills } = await client.skills(sessionId);
    if (!skills.some((skill) => skill.name === explicitSkill)) {
      throw new SkillInvocationError(`no skill named ${explicitSkill}; available: ${skills.map((skill) => skill.name).join(', ') || 'none'}`);
    }
    return { input: prompt, skill: explicitSkill };
  }
  if (parseSlash(prompt) === undefined) return { input: prompt };
  const { skills } = await client.skills(sessionId);
  return skillInvocationOf(prompt, skills.map((skill) => skill.name));
};
