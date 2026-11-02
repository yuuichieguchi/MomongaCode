import { isRecord } from '@momonga/foundation';
import type { AgentDefinition, AgentPin } from './types.ts';

export const pinOf = (agent: AgentDefinition): AgentPin => ({
  name: agent.name,
  description: agent.description,
  prompt: agent.prompt,
  ...(agent.tools === undefined ? {} : { tools: [...agent.tools] }),
  ...(agent.model === undefined ? {} : { model: agent.model }),
});

export const readAgentPin = (pins: Record<string, unknown>): AgentPin | undefined => {
  const value = pins['agent'];
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value['name'] !== 'string' || typeof value['description'] !== 'string' || typeof value['prompt'] !== 'string') {
    throw new TypeError('the agent pin of this run is malformed');
  }
  const { tools, model } = value;
  if (tools !== undefined && !(Array.isArray(tools) && tools.every((entry): entry is string => typeof entry === 'string'))) {
    throw new TypeError('the agent pin of this run holds a malformed tools list');
  }
  if (model !== undefined && typeof model !== 'string') throw new TypeError('the agent pin of this run holds a malformed model');
  return {
    name: value['name'],
    description: value['description'],
    prompt: value['prompt'],
    ...(tools === undefined ? {} : { tools: [...(tools as string[])] }),
    ...(model === undefined ? {} : { model }),
  };
};

export const agentSystemPrompt = (base: string, pin: AgentPin): string =>
  [base, '', `You are working as the subagent "${pin.name}" for another agent that delegated this task to you. Your final message is returned to it as the result.`, '', pin.prompt].join('\n');
