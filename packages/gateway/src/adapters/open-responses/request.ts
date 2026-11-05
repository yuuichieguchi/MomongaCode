import { compactionSummaryMessage } from '@momonga/protocol';
import type { AdapterInputItem, AdapterRequest, ContentPart, InputItem, ReasoningOrigin } from '@momonga/protocol';
import { callArgumentsText } from '../shared/call-arguments.ts';
import { UnsupportedInputError } from '../shared/failures.ts';
import { imageUrlOf, isImagePart } from '../shared/image-part.ts';
import { ownReasoning } from '../shared/reasoning-origin.ts';
import { carriedSamplingOf } from '../shared/sampling.ts';

export type OpenResponsesRequestBody = {
  model: string;
  input: InputItem[];
  stream: true;
  store: false;
  include: ['reasoning.encrypted_content'];
  instructions?: string;
  tools?: AdapterRequest['tools'];
  tool_choice?: AdapterRequest['tool_choice'];
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  prompt_cache_key?: string;
};

const TEXT_PART_TYPES: ReadonlySet<ContentPart['type']> = new Set(['input_text', 'output_text', 'summary_text', 'refusal']);

const relayable = (content: string | ContentPart[], allowed: ReadonlySet<ContentPart['type']>): string | ContentPart[] => {
  if (typeof content === 'string') return content;
  for (const part of content) {
    if (!allowed.has(part.type)) {
      throw new UnsupportedInputError('unsupported_input', `the upstream adapter does not support ${part.type} content here`, 'input');
    }
    if (isImagePart(part)) imageUrlOf(part);
  }
  return content;
};

const USER_PART_TYPES: ReadonlySet<ContentPart['type']> = new Set([...TEXT_PART_TYPES, 'input_image']);

const itemOf = (item: AdapterInputItem, origin: ReasoningOrigin): InputItem | undefined => {
  switch (item.type) {
    case 'reasoning': {
      const own = ownReasoning(item, origin);
      if (own === undefined || own.encrypted_content === undefined || own.encrypted_content === null) return undefined;
      return {
        type: 'reasoning',
        summary: own.summary,
        ...(own.content === undefined || own.content === null ? {} : { content: own.content }),
        encrypted_content: own.encrypted_content,
      };
    }
    case 'compaction_summary':
      return compactionSummaryMessage(item.summary);
    case 'message':
      return { type: 'message', role: item.role, content: relayable(item.content, item.role === 'user' ? USER_PART_TYPES : TEXT_PART_TYPES) };
    case 'function_call':
      return { type: 'function_call', call_id: item.call_id, name: item.name, arguments: callArgumentsText(item.arguments) };
    case 'function_call_output':
      return { type: 'function_call_output', call_id: item.call_id, output: relayable(item.output, USER_PART_TYPES) };
  }
};

export const buildResponsesBody = (request: AdapterRequest, origin: ReasoningOrigin): OpenResponsesRequestBody => {
  const tools = request.tools ?? [];
  return {
    model: request.model,
    input: request.input.flatMap((item) => itemOf(item, origin) ?? []),
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(request.instructions === undefined || request.instructions === null || request.instructions === '' ? {} : { instructions: request.instructions }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(tools.length === 0 || request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
    ...(tools.length === 0 || request.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: request.parallel_tool_calls }),
    ...(request.max_output_tokens === undefined || request.max_output_tokens === null ? {} : { max_output_tokens: request.max_output_tokens }),
    ...carriedSamplingOf(request),
  };
};
