import type { SkillView } from '@momonga/protocol';
import { SkillInvocationError, skillTask } from '../../run/skill-invocation.ts';
import type { SkillInvocation } from '../../run/skill-invocation.ts';
import type { SlashCommand } from '../slash.ts';

export type SkillCommands = { commands: SlashCommand[]; shadowed: string[] };

export const skillCommands = (skills: readonly SkillView[], taken: ReadonlySet<string>): SkillCommands => {
  const commands: SlashCommand[] = [];
  const shadowed: string[] = [];
  for (const skill of skills) {
    if (taken.has(skill.name)) {
      shadowed.push(skill.name);
      continue;
    }
    commands.push({
      name: skill.name,
      usage: '<task>',
      description: skill.description,
      run: async (args, context) => {
        let invocation: SkillInvocation;
        try {
          invocation = skillTask(skill.name, args);
        } catch (error) {
          if (!(error instanceof SkillInvocationError)) throw error;
          context.info(error.message);
          return;
        }
        await context.startRun(invocation.input, { skill: skill.name });
      },
    });
  }
  return { commands, shadowed };
};
