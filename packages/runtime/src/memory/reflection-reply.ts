import { defineProductSchema } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { MEMORY_KINDS } from '@momonga/protocol';
import type { MemoryKind } from '@momonga/protocol';
import { MEMORY_TEXT_MAX_CHARS } from '@momonga/tools';

export type ReflectionCandidate = { text: string; kind: MemoryKind; paths: string[] };

export const REFLECTION_REPLY_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', minLength: 1, maxLength: MEMORY_TEXT_MAX_CHARS },
          kind: { type: 'string', enum: [...MEMORY_KINDS] },
          paths: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
        required: ['text', 'kind', 'paths'],
        additionalProperties: false,
      },
    },
  },
  required: ['candidates'],
  additionalProperties: false,
} as const;

export const validateReflectionReply: ProductValidator<{ candidates: ReflectionCandidate[] }> = defineProductSchema('runtime/reflection-reply', { ...REFLECTION_REPLY_SCHEMA });
