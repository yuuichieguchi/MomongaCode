import type { AdapterInputItem, AdapterRequest, FunctionTool, ReasoningOrigin, ToolChoice } from '@momonga/protocol';
import { SYSTEM_PART_SEPARATOR, systemTextOf } from '../shared/system-text.ts';
import { nativeHistoryOf, plainHistoryOf } from './plain-history.ts';
import type { ChatMessage } from './plain-history.ts';

export type ChatRequestBody = {
  model: string;
  messages: ChatMessage[];
  stream: true;
  stream_options: { include_usage: true };
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  response_format?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  prompt_cache_key?: string;
};

const toolOf = (tool: FunctionTool): unknown => ({
  type: 'function',
  function: {
    name: tool.name,
    ...(tool.description === undefined || tool.description === null ? {} : { description: tool.description }),
    ...(tool.parameters === undefined || tool.parameters === null ? {} : { parameters: tool.parameters }),
  },
});

const toolChoiceOf = (choice: ToolChoice): unknown =>
  typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } };

export const samplingOf = (request: AdapterRequest): Pick<ChatRequestBody, 'temperature' | 'top_p'> => ({
  ...(request.temperature === undefined || request.temperature === null ? {} : { temperature: request.temperature }),
  ...(request.top_p === undefined || request.top_p === null ? {} : { top_p: request.top_p }),
});

export const buildNativeBody = (request: AdapterRequest, origin: ReasoningOrigin): ChatRequestBody => {
  const messages: ChatMessage[] = [];
  const tools = request.tools ?? [];
  const system = systemTextOf(request.instructions, request.input);
  if (system.length > 0) messages.push({ role: 'system', content: system.join(SYSTEM_PART_SEPARATOR) });
  messages.push(...(tools.length === 0 ? plainHistoryOf(request.input, { envelopeReplies: false, origin: origin }) : nativeHistoryOf(request.input, origin)));
  return {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...(tools.length === 0 ? {} : { tools: tools.map(toolOf) }),
    ...(tools.length === 0 || request.tool_choice === undefined ? {} : { tool_choice: toolChoiceOf(request.tool_choice) }),
    ...samplingOf(request),
  };
};
