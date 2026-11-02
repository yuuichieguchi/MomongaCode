import type { AvailableCommand } from '@agentclientprotocol/sdk';
import type { SkillView } from '@momonga/protocol';

export const availableCommandsOf = (skills: readonly SkillView[]): AvailableCommand[] =>
  skills.map((skill) => ({ name: skill.name, description: skill.description }));
