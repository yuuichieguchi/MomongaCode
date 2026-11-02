import type { RuntimeClient } from '../client/runtime-client.ts';
import { parseSlash } from '../tui/slash.ts';

export class SkillInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillInvocationError';
  }
}

export type SkillInvocation = { input: string; skill?: string };

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
  const parsed = parseSlash(prompt);
  if (parsed === undefined) return { input: prompt };
  const { skills } = await client.skills(sessionId);
  if (!skills.some((skill) => skill.name === parsed.name)) return { input: prompt };
  if (parsed.args === '') throw new SkillInvocationError(`/${parsed.name} needs a task to run the skill on: /${parsed.name} <task>`);
  return { input: parsed.args, skill: parsed.name };
};
