import { compactionSummaryMessage } from '@momonga/protocol';
import type { AdapterInputItem, AdapterRequest, FunctionTool, ToolChoice } from '@momonga/protocol';
import { UnsupportedInputError } from '../shared/failures.ts';
import { textOfContent } from '../shared/input-text.ts';
import { SYSTEM_PART_SEPARATOR, systemTextOf } from '../shared/system-text.ts';

export type AnthropicTextBlock = { type: 'text'; text: string };
export type AnthropicToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
export type AnthropicToolResultBlock = { type: 'tool_result'; tool_use_id: string; content?: string };
export type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

export type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicBlock[] };

export type AnthropicToolChoice =
  | { type: 'auto' | 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }
  | { type: 'none' };

export type AnthropicTool = { name: string; description?: string; input_schema: Record<string, unknown> };

export type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  stream: true;
  system?: string;
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  temperature?: number;
  top_p?: number;
};

const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {} } as const;

const parseToolInput = (callId: string, text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UnsupportedInputError('invalid_function_call_arguments', `function_call "${callId}" has arguments that are not valid JSON`, 'input', { cause: error });
  }
};

const textBlocksOf = (text: string): AnthropicTextBlock[] => (text === '' ? [] : [{ type: 'text', text }]);

const blocksOf = (item: AdapterInputItem): { role: AnthropicMessage['role']; blocks: AnthropicBlock[] } | undefined => {
  switch (item.type) {
    case 'reasoning':
      return undefined;
    case 'compaction_summary': {
      const summary = compactionSummaryMessage(item.summary);
      return { role: 'user', blocks: textBlocksOf(textOfContent(summary.content)) };
    }
    case 'function_call':
      return { role: 'assistant', blocks: [{ type: 'tool_use', id: item.call_id, name: item.name, input: parseToolInput(item.call_id, item.arguments) }] };
    case 'function_call_output': {
      const output = textOfContent(item.output);
      return { role: 'user', blocks: [{ type: 'tool_result', tool_use_id: item.call_id, ...(output === '' ? {} : { content: output }) }] };
    }
    case 'message':
      if (item.role === 'system' || item.role === 'developer') return undefined;
      return { role: item.role, blocks: textBlocksOf(textOfContent(item.content)) };
  }
};

const toolResultsFirst = (blocks: AnthropicBlock[]): AnthropicBlock[] => [
  ...blocks.filter((block) => block.type === 'tool_result'),
  ...blocks.filter((block) => block.type !== 'tool_result'),
];

export const messagesOf = (input: readonly AdapterInputItem[]): AnthropicMessage[] => {
  const messages: AnthropicMessage[] = [];
  for (const item of input) {
    const converted = blocksOf(item);
    if (converted === undefined || converted.blocks.length === 0) continue;
    const previous = messages.at(-1);
    if (previous?.role === converted.role) previous.content.push(...converted.blocks);
    else messages.push({ role: converted.role, content: [...converted.blocks] });
  }
  return messages.map((message) => (message.role === 'user' ? { ...message, content: toolResultsFirst(message.content) } : message));
};

const toolOf = (tool: FunctionTool): AnthropicTool => ({
  name: tool.name,
  ...(tool.description === undefined || tool.description === null ? {} : { description: tool.description }),
  input_schema: tool.parameters === undefined || tool.parameters === null ? { ...EMPTY_OBJECT_SCHEMA } : tool.parameters,
});

const toolChoiceOf = (choice: ToolChoice | undefined, parallelToolCalls: boolean | undefined): AnthropicToolChoice | undefined => {
  const serial = parallelToolCalls === false ? { disable_parallel_tool_use: true } : {};
  if (choice === 'none') return { type: 'none' };
  if (choice === undefined) return parallelToolCalls === false ? { type: 'auto', ...serial } : undefined;
  if (choice === 'auto') return { type: 'auto', ...serial };
  if (choice === 'required') return { type: 'any', ...serial };
  return { type: 'tool', name: choice.name, ...serial };
};

export const buildMessagesBody = (request: AdapterRequest, maxTokens: number): AnthropicRequestBody => {
  const tools = request.tools ?? [];
  const system = systemTextOf(request.instructions, request.input);
  const toolChoice = tools.length === 0 ? undefined : toolChoiceOf(request.tool_choice, request.parallel_tool_calls);
  return {
    model: request.model,
    max_tokens: request.max_output_tokens ?? maxTokens,
    stream: true,
    ...(system.length === 0 ? {} : { system: system.join(SYSTEM_PART_SEPARATOR) }),
    messages: messagesOf(request.input),
    ...(tools.length === 0 ? {} : { tools: tools.map(toolOf) }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(request.temperature === undefined || request.temperature === null ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined || request.top_p === null ? {} : { top_p: request.top_p }),
  };
};
