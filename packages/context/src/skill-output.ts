import { skillContentOpenTag } from '@momonga/protocol';
import type { InputItem } from '@momonga/protocol';
import type { ActivatedSkill } from './types.ts';
import { outputTextOf, withOutput } from './tool-output.ts';

export const activeSkillPointer = (name: string): string => `Skill ${name} is active. Its instructions are kept in the protected context above.`;

export const heldSkillOf = (item: InputItem, activated: readonly Pick<ActivatedSkill, 'name'>[]): string | undefined => {
  if (item.type !== 'function_call_output') return undefined;
  const text = outputTextOf(item.output);
  return activated.find((skill) => text.startsWith(skillContentOpenTag(skill.name)))?.name;
};

export const pointToHeldSkill = (item: InputItem, activated: readonly Pick<ActivatedSkill, 'name'>[]): InputItem => {
  const name = heldSkillOf(item, activated);
  return name === undefined || item.type !== 'function_call_output' ? item : withOutput(item, activeSkillPointer(name));
};
