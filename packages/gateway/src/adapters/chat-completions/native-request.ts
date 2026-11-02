import type { AdapterInputItem, AdapterRequest, FunctionTool, ToolChoice } from '@momonga/protocol';
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
  response_format?: unknown;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
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

export const samplingOf = (request: AdapterRequest): Pick<ChatRequestBody, 'max_tokens' | 'temperature' | 'top_p'> => ({
  ...(request.max_output_tokens === undefined || request.max_output_tokens === null ? {} : { max_tokens: request.max_output_tokens }),
  ...(request.temperature === undefined || request.temperature === null ? {} : { temperature: request.temperature }),
  ...(request.top_p === undefined || request.top_p === null ? {} : { top_p: request.top_p }),
});

export const buildNativeBody = (request: AdapterRequest): ChatRequestBody => {
  const messages: ChatMessage[] = [];
  const tools = request.tools ?? [];
  const system = systemTextOf(request.instructions, request.input);
  if (system.length > 0) messages.push({ role: 'system', content: system.join(SYSTEM_PART_SEPARATOR) });
  messages.push(...(tools.length === 0 ? plainHistoryOf(request.input, { envelopeReplies: false }) : nativeHistoryOf(request.input)));
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
