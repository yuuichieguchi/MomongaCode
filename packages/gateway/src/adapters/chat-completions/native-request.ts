import type { AdapterInputItem, AdapterRequest, FunctionTool, ToolChoice } from '@momonga/protocol';
import { neutralizeMarkup, textOfContent } from './input-text.ts';

export type ChatMessage = Record<string, unknown>;

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

export const SYSTEM_PART_SEPARATOR = '\n\n';

export const systemTextOf = (instructions: string | null | undefined, input: readonly AdapterInputItem[]): string[] => {
  const parts: string[] = [];
  if (instructions !== undefined && instructions !== null && instructions !== '') parts.push(instructions);
  for (const item of input) {
    if (item.type === 'message' && (item.role === 'system' || item.role === 'developer')) {
      parts.push(textOfContent(item.content));
    }
  }
  return parts.filter((part) => part !== '');
};

export const summaryMessageOf = (summary: string): ChatMessage => ({
  role: 'user',
  content: `<conversation_summary>\n${neutralizeMarkup(summary)}\n</conversation_summary>`,
});

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
  const system = systemTextOf(request.instructions, request.input);
  if (system.length > 0) messages.push({ role: 'system', content: system.join(SYSTEM_PART_SEPARATOR) });
  let pendingCalls: unknown[] = [];
  const flushCalls = (): void => {
    if (pendingCalls.length === 0) return;
    messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
    pendingCalls = [];
  };
  for (const item of request.input) {
    if (item.type === 'reasoning') continue;
    if (item.type === 'function_call') {
      pendingCalls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
      continue;
    }
    flushCalls();
    if (item.type === 'compaction_summary') {
      messages.push(summaryMessageOf(item.summary));
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: textOfContent(item.output) });
    } else if (item.role === 'user' || item.role === 'assistant') {
      messages.push({ role: item.role, content: textOfContent(item.content) });
    }
  }
  flushCalls();
  const tools = request.tools ?? [];
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
