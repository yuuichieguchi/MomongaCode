import { encodeSse } from '@momonga/foundation';
import type { StreamEvent } from '@momonga/protocol';

const encoder = new TextEncoder();
const cache = new WeakMap<StreamEvent, Uint8Array>();

export const frameOf = (event: StreamEvent): Uint8Array => {
  const cached = cache.get(event);
  if (cached !== undefined) return cached;
  const frame = encoder.encode(encodeSse({ event: event.type, data: JSON.stringify(event) }));
  cache.set(event, frame);
  return frame;
};
