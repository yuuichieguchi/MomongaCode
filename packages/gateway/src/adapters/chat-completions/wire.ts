import type { ChatRequestBody } from './native-request.ts';
import type { ChatMessage } from './plain-history.ts';

export type ChatWire = {
  messages?: ChatMessage[];
  tools?: unknown[];
  response_format?: unknown;
};

const WIRE_KEYS: ReadonlySet<string> = new Set(['messages', 'tools', 'response_format']);

export const wireOf = (body: Pick<ChatRequestBody, 'messages' | 'tools' | 'response_format'>): ChatWire =>
  Object.fromEntries(Object.entries(body).filter(([key]) => WIRE_KEYS.has(key)));
