import { defineProductSchema } from '@momonga/foundation';
import type { ProductValidator } from '@momonga/foundation';
import { REFLECTION_REPLY_SCHEMA } from './reflection-reply-schema.ts';
import type { ReflectionCandidate } from './reflection-reply-schema.ts';

export { REFLECTION_REPLY_SCHEMA } from './reflection-reply-schema.ts';
export type { ReflectionCandidate } from './reflection-reply-schema.ts';

export const validateReflectionReply: ProductValidator<{ candidates: ReflectionCandidate[] }> = defineProductSchema('runtime/reflection-reply', { ...REFLECTION_REPLY_SCHEMA });
