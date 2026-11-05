import type { ItemField, StreamEvent } from '@momonga/protocol';
import type { ReasoningOriginCodec } from './reasoning-origin.ts';

export const sealedEventOf = (codec: ReasoningOriginCodec, adapter: string, model: string, event: StreamEvent): StreamEvent => {
  const sealed = (item: ItemField): ItemField => (item.type === 'reasoning' ? codec.seal(adapter, model, item) : item);
  switch (event.type) {
    case 'response.output_item.done':
      return { ...event, item: sealed(event.item) };
    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
      return { ...event, response: { ...event.response, output: event.response.output.map(sealed) } } as StreamEvent;
    default:
      return event;
  }
};
