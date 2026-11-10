import type { Capabilities } from './capabilities.ts';
import type { JsonReplyPath, TextFormat } from './open-responses.ts';

export const jsonReplyPathFor = (format: TextFormat | null | undefined, capabilities: Pick<Capabilities, 'structuredOutput' | 'jsonMode'>): JsonReplyPath | undefined => {
  if (format === undefined || format === null || format.type === 'text') return undefined;
  if (format.type === 'json_object') return capabilities.jsonMode === 'json_object' ? 'enforced' : 'prompt';
  return capabilities.structuredOutput === 'json_schema' ? 'enforced' : 'prompt';
};
