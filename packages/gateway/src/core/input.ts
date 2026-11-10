import type { AdapterInputItem, ContentPart, FunctionTool, InputContentKind, InputItem, RequestToolKind } from '@momonga/protocol';
import type { CompactionCodec } from './compaction.ts';
import { invalidRequest, notFound } from './errors.ts';
import type { GatewayStore, StoredResponse } from './store.ts';

export type ConnectionResponses = {
  lookup(id: string): StoredResponse | undefined;
  remember(id: string, response: StoredResponse): void;
  evict(id: string): void;
};

export const normalizeInput = (input: string | InputItem[] | null | undefined): InputItem[] => {
  if (input === undefined || input === null) return [];
  if (typeof input === 'string') return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input }] }];
  return input;
};

export type ResolvedInput = {
  stored: InputItem[];
  forAdapter: AdapterInputItem[];
};

export const resolveInput = (
  store: GatewayStore,
  codec: CompactionCodec,
  previousResponseId: string | null | undefined,
  clientInput: InputItem[],
  connection?: ConnectionResponses,
): ResolvedInput => {
  const prior =
    previousResponseId === undefined || previousResponseId === null ? undefined : (connection?.lookup(previousResponseId) ?? store.getResponse(previousResponseId));
  if (previousResponseId !== undefined && previousResponseId !== null && prior === undefined) {
    throw notFound('previous_response_not_found', `previous response "${previousResponseId}" was not found or was not stored`, 'previous_response_id');
  }
  const priorItems: InputItem[] = prior === undefined ? [] : [...prior.input, ...prior.output];
  const stored = [...priorItems, ...clientInput];
  const forAdapter = stored.map((item, index): AdapterInputItem => {
    if (item.type !== 'compaction') return item;
    const summary = codec.decode(item.encrypted_content);
    if (summary === undefined) {
      const param = index < priorItems.length ? 'previous_response_id' : `input[${index - priorItems.length}].encrypted_content`;
      throw invalidRequest('invalid_compaction', 'compaction item failed verification and was not produced by this gateway', param);
    }
    return { type: 'compaction_summary', summary };
  });
  return { stored, forAdapter };
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
