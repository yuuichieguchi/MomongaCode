import { promptPartsOf } from '../../core/prompt-parts.ts';
import type { ChatRequestBody } from './native-request.ts';
import type { ChatMessage } from './plain-history.ts';

export type ChatWire = {
  messages?: ChatMessage[];
  tools?: unknown[];
};

export const wireOf = (body: Pick<ChatRequestBody, 'messages' | 'tools'>): ChatWire => promptPartsOf(body);
