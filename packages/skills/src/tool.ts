import { defineTool, ToolExecutionError } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { ACTIVATE_SKILL_TIMEOUT_MS, ACTIVATE_SKILL_TOOL_NAME } from './constants.ts';
import { SkillActivationError } from './types.ts';
import type { Skill, SkillContent } from './types.ts';

type ActivateSkillInput = { name: string };

export type ActivationToolDependencies = {
  skills: readonly Skill[];
  activate(name: string): Promise<SkillContent>;
  isActive(name: string): boolean;
};

export const createActivateSkillTool = ({ skills, activate, isActive }: ActivationToolDependencies): AnyTool => {
  const claimed = new Set<string>();
  return defineTool<ActivateSkillInput>({
    name: ACTIVATE_SKILL_TOOL_NAME,
    description:
      'Loads the full instructions of an agent skill from the skill catalog. Call it when the task matches the skill description; the instructions stay in your context for the rest of the conversation, so activate each skill once.',
    kind: 'read',
    sideEffect: 'read_only',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', enum: skills.map((skill) => skill.name), description: 'Name of the skill to activate' } },
      required: ['name'],
      additionalProperties: false,
    },
    timeoutMs: ACTIVATE_SKILL_TIMEOUT_MS,
    title: (input) => `Activate skill ${input.name}`,
    subject: () => ({ kind: 'none', tool: ACTIVATE_SKILL_TOOL_NAME }),
    execute: async (input) => {
      if (isActive(input.name) || claimed.has(input.name)) {
        return { status: 'completed', output: `Skill ${input.name} is already active; its instructions are already in your context.` };
      }
      claimed.add(input.name);
      try {
        const skill = await activate(input.name);
        return { status: 'completed', output: skill.content, skill };
      } catch (error) {
        claimed.delete(input.name);
        if (error instanceof SkillActivationError) throw new ToolExecutionError(error.message);
        throw error;
      }
    },
  });
};
