import type { SkillView } from '@momonga/protocol';
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
        if (args === '') {
          context.info(`/${skill.name} needs a task to run the skill on: /${skill.name} <task>`);
          return;
        }
        await context.startRun(args, { skill: skill.name });
      },
    });
  }
  return { commands, shadowed };
};
