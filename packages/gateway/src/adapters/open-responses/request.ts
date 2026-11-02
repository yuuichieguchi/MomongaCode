import { compactionSummaryMessage } from '@momonga/protocol';
import type { AdapterInputItem, AdapterRequest, ContentPart, InputItem } from '@momonga/protocol';
import { UnsupportedInputError } from '../shared/failures.ts';

export type OpenResponsesRequestBody = {
  model: string;
  input: InputItem[];
  stream: true;
  store: false;
  instructions?: string;
  tools?: AdapterRequest['tools'];
  tool_choice?: AdapterRequest['tool_choice'];
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
};

const TEXT_PART_TYPES: ReadonlySet<ContentPart['type']> = new Set(['input_text', 'output_text', 'summary_text', 'refusal']);

const textOnly = (content: string | ContentPart[]): string | ContentPart[] => {
  if (typeof content === 'string') return content;
  for (const part of content) {
    if (!TEXT_PART_TYPES.has(part.type)) {
      throw new UnsupportedInputError('unsupported_input', `the upstream adapter does not support ${part.type} content`, 'input');
    }
  }
  return content;
};

const itemOf = (item: AdapterInputItem): InputItem | undefined => {
  switch (item.type) {
    case 'reasoning':
      return undefined;
    case 'compaction_summary':
      return compactionSummaryMessage(item.summary);
    case 'message':
      return { type: 'message', role: item.role, content: textOnly(item.content) };
    case 'function_call':
      return { type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments };
    case 'function_call_output':
      return { type: 'function_call_output', call_id: item.call_id, output: textOnly(item.output) };
  }
};

export const buildResponsesBody = (request: AdapterRequest): OpenResponsesRequestBody => {
  const tools = request.tools ?? [];
  return {
    model: request.model,
    input: request.input.flatMap((item) => itemOf(item) ?? []),
    stream: true,
    store: false,
    ...(request.instructions === undefined || request.instructions === null || request.instructions === '' ? {} : { instructions: request.instructions }),
    ...(tools.length === 0 ? {} : { tools }),
    ...(tools.length === 0 || request.tool_choice === undefined ? {} : { tool_choice: request.tool_choice }),
    ...(tools.length === 0 || request.parallel_tool_calls === undefined ? {} : { parallel_tool_calls: request.parallel_tool_calls }),
    ...(request.max_output_tokens === undefined || request.max_output_tokens === null ? {} : { max_output_tokens: request.max_output_tokens }),
    ...(request.temperature === undefined || request.temperature === null ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined || request.top_p === null ? {} : { top_p: request.top_p }),
  };
};
