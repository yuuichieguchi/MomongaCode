import type { AdapterInputItem, ContentPart, InputItem } from '@momonga/protocol';
import type { CompactionCodec } from './compaction.ts';
import { invalidRequest, notFound } from './errors.ts';
import type { GatewayStore } from './store.ts';

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
): ResolvedInput => {
  const prior = previousResponseId === undefined || previousResponseId === null ? undefined : store.getResponse(previousResponseId);
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
