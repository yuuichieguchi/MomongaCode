import type { AdapterInputItem, AdapterRequest, FunctionTool, ToolChoice } from '@momonga/protocol';
import { FULL_KEYWORD_SUPPORT } from '../../probe/lowering.ts';
import { renderParameters } from '../../probe/schema-dialect.ts';
import type { SchemaDialect } from '../../probe/schema-dialect.ts';
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

const toolOf = (tool: FunctionTool, dialect: SchemaDialect): unknown => {
  const parameters = renderParameters(tool.parameters, dialect, FULL_KEYWORD_SUPPORT);
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description === undefined || tool.description === null ? {} : { description: tool.description }),
      ...(parameters === undefined ? {} : { parameters }),
    },
  };
};

const toolChoiceOf = (choice: ToolChoice): unknown =>
  typeof choice === 'string' ? choice : { type: 'function', function: { name: choice.name } };

export const samplingOf = (request: AdapterRequest): Pick<ChatRequestBody, 'temperature' | 'top_p'> => ({
  ...(request.temperature === undefined || request.temperature === null ? {} : { temperature: request.temperature }),
  ...(request.top_p === undefined || request.top_p === null ? {} : { top_p: request.top_p }),
});

export const buildNativeBody = (request: AdapterRequest, dialect: SchemaDialect): ChatRequestBody => {
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
    ...(tools.length === 0 ? {} : { tools: tools.map((tool) => toolOf(tool, dialect)) }),
    ...(tools.length === 0 || request.tool_choice === undefined ? {} : { tool_choice: toolChoiceOf(request.tool_choice) }),
    ...samplingOf(request),
  };
};
