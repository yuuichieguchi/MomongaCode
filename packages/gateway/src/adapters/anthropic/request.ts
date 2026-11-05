import { compactionSummaryMessage } from '@momonga/protocol';
import type { AdapterInputItem, AdapterRequest, ContentPart, FunctionTool, PromptCacheCounts, ReasoningOrigin, ToolChoice } from '@momonga/protocol';
import { callArgumentsObject } from '../shared/call-arguments.ts';
import { UnsupportedInputError } from '../shared/failures.ts';
import { hasImagePart, imageSourceOf } from '../shared/image-part.ts';
import { reasoningTextOf, textOfContent } from '../shared/input-text.ts';
import { ownReasoning } from '../shared/reasoning-origin.ts';

export type CacheControl = { type: 'ephemeral' };
type Cacheable = { cache_control?: CacheControl };

export type AnthropicTextBlock = { type: 'text'; text: string } & Cacheable;
export type AnthropicImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
} & Cacheable;
export type AnthropicToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown } & Cacheable;
export type AnthropicToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
} & Cacheable;
export type AnthropicThinkingBlock = { type: 'thinking'; thinking: string; signature: string };
export type AnthropicBlock = AnthropicTextBlock | AnthropicImageBlock | AnthropicToolUseBlock | AnthropicToolResultBlock | AnthropicThinkingBlock;

export type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicBlock[] };

export type RawAssistantMessage = { role: 'assistant'; content: readonly Record<string, unknown>[] };

export type AnthropicToolChoice =
  | { type: 'auto' | 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }
  | { type: 'none' };

export type AnthropicTool = { name: string; description?: string; input_schema: Record<string, unknown> } & Cacheable;

export type AnthropicRequestBody = {
  model: string;
  max_tokens: number;
  stream: true;
  system?: AnthropicTextBlock[];
  messages: Array<AnthropicMessage | RawAssistantMessage>;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  temperature?: number;
  top_p?: number;
};

export type AnthropicCountTokensBody = Pick<AnthropicRequestBody, 'model' | 'system' | 'tools' | 'tool_choice'> & { messages: AnthropicMessage[] };

export type CachePlan = { maxBreakpoints: number; marks?: PromptCacheCounts };

export type BodyOptions = { cache: CachePlan | undefined };

const EPHEMERAL: CacheControl = { type: 'ephemeral' };
const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {} } as const;
const SUPPORTED_IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const textBlocksOf = (text: string): AnthropicTextBlock[] => (text === '' ? [] : [{ type: 'text', text }]);

const imageBlockOf = (part: Extract<ContentPart, { type: 'input_image' }>): AnthropicImageBlock => {
  const source = imageSourceOf(part);
  if (source.kind === 'url') return { type: 'image', source: { type: 'url', url: source.url } };
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(source.mediaType)) {
    throw new UnsupportedInputError('invalid_image', `the Anthropic Messages API accepts image/jpeg, image/png, image/gif and image/webp, not ${source.mediaType}`, 'input');
  }
  return { type: 'image', source: { type: 'base64', media_type: source.mediaType, data: source.data } };
};

const partBlocksOf = (content: string | readonly ContentPart[]): Array<AnthropicTextBlock | AnthropicImageBlock> => {
  if (typeof content === 'string') return textBlocksOf(content);
  return content.flatMap((part): Array<AnthropicTextBlock | AnthropicImageBlock> => {
    if (part.type === 'input_image') return [imageBlockOf(part)];
    return textBlocksOf(textOfContent([part]));
  });
};

type Converted = { role: AnthropicMessage['role']; blocks: AnthropicBlock[] };

const blocksOf = (item: AdapterInputItem, origin: ReasoningOrigin): Converted | undefined => {
  switch (item.type) {
    case 'reasoning': {
      const own = ownReasoning(item, origin);
      return own === undefined || own.signature === undefined || own.signature === null
        ? undefined
        : { role: 'assistant', blocks: [{ type: 'thinking', thinking: reasoningTextOf(own), signature: own.signature }] };
    }
    case 'compaction_summary': {
      const summary = compactionSummaryMessage(item.summary);
      return { role: 'user', blocks: textBlocksOf(textOfContent(summary.content)) };
    }
    case 'function_call':
      return { role: 'assistant', blocks: [{ type: 'tool_use', id: item.call_id, name: item.name, input: callArgumentsObject(item.arguments) }] };
    case 'function_call_output': {
      const content = hasImagePart(item.output) ? partBlocksOf(item.output) : textOfContent(item.output);
      return { role: 'user', blocks: [{ type: 'tool_result', tool_use_id: item.call_id, ...(content === '' ? {} : { content }) }] };
    }
    case 'message':
      if (item.role === 'system' || item.role === 'developer') return undefined;
      if (item.role === 'assistant') return { role: 'assistant', blocks: textBlocksOf(textOfContent(item.content)) };
      return { role: 'user', blocks: partBlocksOf(item.content) };
  }
};

type Placed = { block: AnthropicBlock; origin: number };

type PlacedMessage = { role: AnthropicMessage['role']; placed: Placed[] };

const toolResultsFirst = (placed: Placed[]): Placed[] => [
  ...placed.filter((entry) => entry.block.type === 'tool_result'),
  ...placed.filter((entry) => entry.block.type !== 'tool_result'),
];

const isStablePrefixItem = (item: AdapterInputItem): boolean =>
  item.type === 'compaction_summary' || (item.type === 'message' && (item.role === 'system' || item.role === 'developer'));

const stablePrefixLength = (input: readonly AdapterInputItem[]): number => {
  const first = input.findIndex((item) => !isStablePrefixItem(item));
  return first === -1 ? input.length : first;
};

type ConvertedMessages = { messages: AnthropicMessage[]; stablePrefixEnd: AnthropicBlock | undefined; placed: Placed[] };

const convertMessages = (input: readonly AdapterInputItem[], origin: ReasoningOrigin): ConvertedMessages => {
  const grouped: PlacedMessage[] = [];
  const prefixLength = stablePrefixLength(input);
  let stablePrefixEnd: AnthropicBlock | undefined;
  for (const [index, item] of input.entries()) {
    const converted = blocksOf(item, origin);
    if (converted === undefined || converted.blocks.length === 0) continue;
    if (index < prefixLength) stablePrefixEnd = converted.blocks.at(-1);
    const placed = converted.blocks.map((block): Placed => ({ block, origin: index }));
    const previous = grouped.at(-1);
    if (previous?.role === converted.role) previous.placed.push(...placed);
    else grouped.push({ role: converted.role, placed });
  }
  const ordered = grouped.map((message): PlacedMessage => (message.role === 'user' ? { ...message, placed: toolResultsFirst(message.placed) } : message));
  return {
    messages: ordered.map((message): AnthropicMessage => ({ role: message.role, content: message.placed.map((entry) => entry.block) })),
    stablePrefixEnd,
    placed: ordered.flatMap((message) => message.placed),
  };
};

export const messagesOf = (input: readonly AdapterInputItem[], origin: ReasoningOrigin): AnthropicMessage[] => convertMessages(input, origin).messages;

type PlacedSystem = { block: AnthropicTextBlock; origin: number };

const INSTRUCTIONS_ORIGIN = -1;

const systemPlacedOf = (instructions: string | null | undefined, input: readonly AdapterInputItem[]): PlacedSystem[] => [
  ...(instructions === undefined || instructions === null ? [] : textBlocksOf(instructions).map((block) => ({ block, origin: INSTRUCTIONS_ORIGIN }))),
  ...input.flatMap((item, index) =>
    item.type === 'message' && (item.role === 'system' || item.role === 'developer')
      ? textBlocksOf(textOfContent(item.content)).map((block) => ({ block, origin: index }))
      : [],
  ),
];

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

const isThinking = (block: AnthropicBlock | AnthropicTool): block is AnthropicThinkingBlock => 'type' in block && block.type === 'thinking';

const withBreakpoints = (tools: AnthropicTool[], system: AnthropicTextBlock[], converted: ConvertedMessages, maxBreakpoints: number): void => {
  const candidates = [converted.messages.at(-1)?.content.at(-1), converted.stablePrefixEnd, system.at(-1), tools.at(-1)];
  const marked = new Set<Cacheable>();
  for (const block of candidates) {
    if (marked.size >= maxBreakpoints) return;
    if (block === undefined || isThinking(block) || marked.has(block)) continue;
    block.cache_control = EPHEMERAL;
    marked.add(block);
  }
};

const blockAtMark = (wire: readonly Placed[], mark: number): Cacheable | undefined => {
  const boundary = wire.findLastIndex((entry) => entry.origin >= 0 && entry.origin < mark);
  for (let at = boundary; at >= 0; at -= 1) {
    const { block } = wire[at] as Placed;
    if (!isThinking(block)) return block;
  }
  return undefined;
};

const withMarks = (system: readonly PlacedSystem[], converted: ConvertedMessages, plan: Required<CachePlan>): void => {
  const wire: Placed[] = [...system, ...converted.placed];
  const { history, stable, fixed, previousHistory } = plan.marks;
  const marked = new Set<Cacheable>();
  for (const mark of [history, stable, fixed, previousHistory]) {
    if (marked.size >= plan.maxBreakpoints) return;
    if (mark === undefined) continue;
    const block = blockAtMark(wire, mark);
    if (block === undefined || marked.has(block)) continue;
    block.cache_control = EPHEMERAL;
    marked.add(block);
  }
};

const requestParts = (request: AdapterRequest, options: BodyOptions, origin: ReasoningOrigin) => {
  const tools = (request.tools ?? []).map(toolOf);
  const placedSystem = systemPlacedOf(request.instructions, request.input);
  const system = placedSystem.map((entry) => entry.block);
  const converted = convertMessages(request.input, origin);
  const { cache } = options;
  if (cache?.marks !== undefined) withMarks(placedSystem, converted, { maxBreakpoints: cache.maxBreakpoints, marks: cache.marks });
  else if (cache !== undefined) withBreakpoints(tools, system, converted, cache.maxBreakpoints);
  const toolChoice = tools.length === 0 ? undefined : toolChoiceOf(request.tool_choice, request.parallel_tool_calls);
  return { tools, system, messages: converted.messages, toolChoice };
};

export const buildMessagesBody = (request: AdapterRequest, maxTokens: number, options: BodyOptions, origin: ReasoningOrigin): AnthropicRequestBody => {
  const { tools, system, messages, toolChoice } = requestParts(request, options, origin);
  return {
    model: request.model,
    max_tokens: request.max_output_tokens ?? maxTokens,
    stream: true,
    ...(system.length === 0 ? {} : { system }),
    messages,
    ...(tools.length === 0 ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
    ...(request.temperature === undefined || request.temperature === null ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined || request.top_p === null ? {} : { top_p: request.top_p }),
  };
};

export const buildCountTokensBody = (request: AdapterRequest, origin: ReasoningOrigin): AnthropicCountTokensBody => {
  const { tools, system, messages, toolChoice } = requestParts(request, { cache: undefined }, origin);
  return {
    model: request.model,
    ...(system.length === 0 ? {} : { system }),
    messages,
    ...(tools.length === 0 ? {} : { tools }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
};

const hasUrlImage = (blocks: readonly unknown[]): boolean =>
  blocks.some((block) => {
    if (typeof block !== 'object' || block === null) return false;
    const record = block as { type?: unknown; source?: { type?: unknown }; content?: unknown };
    if (record.type === 'image') return record.source?.type === 'url';
    return Array.isArray(record.content) && hasUrlImage(record.content);
  });

export const assertCountable = (body: AnthropicCountTokensBody): void => {
  if (body.messages.some((message) => hasUrlImage(message.content))) {
    throw new UnsupportedInputError(
      'unsupported_input',
      'the Anthropic count_tokens endpoint cannot count an image given by URL; send the image as a base64 data: URL',
      'input',
    );
  }
};
