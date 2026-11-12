import type { AdapterInputItem, ContentPart, FunctionTool, InputContentKind, InputItem, RequestToolKind } from '@momonga/protocol';
import type { CompactionCodec } from './compaction.ts';
import { invalidRequest } from './errors.ts';

export const refuseStoredResponses = (body: Readonly<Record<string, unknown>>): void => {
  if (body['store'] === true) {
    throw invalidRequest('stored_responses_unsupported', 'no response is kept for a later call; send store: false and the whole input', 'store');
  }
  if (body['previous_response_id'] !== undefined && body['previous_response_id'] !== null) {
    throw invalidRequest('stored_responses_unsupported', 'no response is kept for a later call to continue; send the whole input instead of previous_response_id', 'previous_response_id');
  }
};

export const normalizeInput = (input: string | InputItem[] | null | undefined): InputItem[] => {
  if (input === undefined || input === null) return [];
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }];
  return input;
};

export type ResolvedInput = {
  forAdapter: AdapterInputItem[];
};

export const resolveInput = (codec: CompactionCodec, clientInput: InputItem[]): ResolvedInput => {
  const forAdapter = clientInput.map((item, index): AdapterInputItem => {
    if (item.type !== 'compaction') return item;
    const summary = codec.decode(item.encrypted_content);
    if (summary === undefined) {
      throw invalidRequest('invalid_compaction', 'compaction item failed verification and was not produced by this gateway', `input[${index}].encrypted_content`);
    }
    return { type: 'compaction_summary', summary };
  });
  return { forAdapter };
};

const partsHaveImage = (content: string | readonly ContentPart[]): boolean =>
  typeof content !== 'string' && content.some((part) => part.type === 'input_image');

export const inputHasImages = (input: readonly (AdapterInputItem | InputItem)[]): boolean =>
  input.some((item) => {
    if (item.type === 'message') return partsHaveImage(item.content);
    if (item.type === 'function_call_output') return partsHaveImage(item.output);
    return false;
  });

const CONTENT_KIND_OF_PART: Readonly<Partial<Record<ContentPart['type'], InputContentKind>>> = { input_file: 'file' };

const contentKindsOf = (content: string | readonly ContentPart[]): InputContentKind[] =>
  typeof content === 'string' ? [] : content.flatMap((part) => CONTENT_KIND_OF_PART[part.type] ?? []);

export type InputKindsRequirement = { content: InputContentKind[]; tools: RequestToolKind[] };

export const inputKindsOf = (input: readonly (AdapterInputItem | InputItem)[], tools: readonly FunctionTool[] | null | undefined): InputKindsRequirement => {
  const content = input.flatMap((item) => {
    if (item.type === 'message') return contentKindsOf(item.content);
    if (item.type === 'function_call_output') return contentKindsOf(item.output);
    return [];
  });
  return { content: [...new Set(content)], tools: [...new Set((tools ?? []).map((tool) => tool.type))] };
};
