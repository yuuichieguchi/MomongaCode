import { isRecord } from '@momonga/foundation';
import { CHAT_REASONING_FIELDS, cachedDetailOf } from '@momonga/protocol';
import type { ChatReasoningField, Usage } from '@momonga/protocol';
import { UpstreamProtocolError } from '../shared/failures.ts';
import { parseUpstreamJson } from '../shared/upstream-json.ts';

export type ToolCallFragment = {
  index: number;
  id: string | undefined;
  name: string | undefined;
  arguments: string | undefined;
};

export type ChunkReasoning = { field: ChatReasoningField; text: string };

export type UpstreamChunk = {
  content: string | undefined;
  reasoning: ChunkReasoning | undefined;
  refusal: string | undefined;
  toolCalls: ToolCallFragment[];
  finishReason: string | undefined;
  usage: Usage | undefined;
  promptProgress: boolean;
};

const invalid = (what: string): UpstreamProtocolError => new UpstreamProtocolError(`the upstream sent a malformed chunk: ${what}`);

const optionalString = (value: unknown, what: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw invalid(`${what} must be a string`);
  return value;
};

const tokenCount = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(`${what} must be a non-negative integer`);
  }
  return value;
};

const reportedTokenCount = (container: unknown, key: string, what: string): number | undefined => {
  if (container === undefined || container === null) return undefined;
  if (!isRecord(container)) throw invalid(`${what} must be an object`);
  const value = container[key];
  return value === undefined || value === null ? undefined : tokenCount(value, `${what}.${key}`);
};

const usageOf = (value: unknown): Usage | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw invalid('usage must be an object');
  const input = tokenCount(value['prompt_tokens'], 'usage.prompt_tokens');
  const output = tokenCount(value['completion_tokens'], 'usage.completion_tokens');
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: cachedDetailOf(reportedTokenCount(value['prompt_tokens_details'], 'cached_tokens', 'usage.prompt_tokens_details')),
    output_tokens_details: {
      reasoning_tokens: reportedTokenCount(value['completion_tokens_details'], 'reasoning_tokens', 'usage.completion_tokens_details') ?? 0,
    },
  };
};

const reasoningOf = (delta: Record<string, unknown>): ChunkReasoning | undefined => {
  const carried = CHAT_REASONING_FIELDS.flatMap((field): ChunkReasoning[] => {
    const text = optionalString(delta[field], `delta.${field}`);
    return text === undefined || text === '' ? [] : [{ field, text }];
  });
  return carried[0];
};

const fragmentOf = (value: unknown): ToolCallFragment => {
  if (!isRecord(value)) throw invalid('a tool_calls entry must be an object');
  const { index } = value;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
    throw invalid('a tool_calls entry needs a non-negative integer index');
  }
  const fn = value['function'];
  if (fn !== undefined && fn !== null && !isRecord(fn)) throw invalid('tool_calls[].function must be an object');
  return {
    index,
    id: optionalString(value['id'], 'tool_calls[].id'),
    name: optionalString(isRecord(fn) ? fn['name'] : undefined, 'tool_calls[].function.name'),
    arguments: optionalString(isRecord(fn) ? fn['arguments'] : undefined, 'tool_calls[].function.arguments'),
  };
};

export const parseUpstreamChunk = (data: string): UpstreamChunk => {
  const parsed = parseUpstreamJson(data, invalid);
  if (!isRecord(parsed)) throw invalid('it is not a JSON object');
  const usage = usageOf(parsed['usage']);
  const promptProgress = isRecord(parsed['prompt_progress']);
  const choices = parsed['choices'];
  if (choices === undefined) {
    if (usage === undefined && !promptProgress) throw invalid('it has neither choices nor usage');
    return { content: undefined, reasoning: undefined, refusal: undefined, toolCalls: [], finishReason: undefined, usage, promptProgress };
  }
  if (!Array.isArray(choices)) throw invalid('choices must be an array');
  if (choices.length > 1) throw invalid('the upstream returned more than one choice');
  const choice: unknown = choices[0];
  if (choice === undefined) return { content: undefined, reasoning: undefined, refusal: undefined, toolCalls: [], finishReason: undefined, usage, promptProgress };
  if (!isRecord(choice)) throw invalid('a choice must be an object');
  const delta = choice['delta'] ?? {};
  if (!isRecord(delta)) throw invalid('delta must be an object');
  const toolCalls = delta['tool_calls'];
  if (toolCalls !== undefined && toolCalls !== null && !Array.isArray(toolCalls)) throw invalid('delta.tool_calls must be an array');
  return {
    content: optionalString(delta['content'], 'delta.content'),
    reasoning: reasoningOf(delta),
    refusal: optionalString(delta['refusal'], 'delta.refusal'),
    toolCalls: Array.isArray(toolCalls) ? toolCalls.map(fragmentOf) : [],
    finishReason: optionalString(choice['finish_reason'], 'finish_reason'),
    usage,
    promptProgress,
  };
};
