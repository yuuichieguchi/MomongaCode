import type { ItemField, ProviderAdapter, StreamEvent } from '@momonga/protocol';
import type { ReasoningOriginCodec } from './reasoning-origin.ts';

export const withReasoningOrigin = (inner: ProviderAdapter, codec: ReasoningOriginCodec): ProviderAdapter => {
  const { countTokens, countWire, compact, renderWire, renderCompactWire, health, close } = inner;

  const sealedItem = (item: ItemField, model: string): ItemField => (item.type === 'reasoning' ? codec.seal(inner.kind, model, item) : item);

  const sealedEvent = (event: StreamEvent, model: string): StreamEvent => {
    switch (event.type) {
      case 'response.output_item.done':
        return { ...event, item: sealedItem(event.item, model) };
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed':
        return { ...event, response: { ...event.response, output: event.response.output.map((item) => sealedItem(item, model)) } } as StreamEvent;
      default:
        return event;
    }
  };

  async function* create(...args: Parameters<ProviderAdapter['create']>): AsyncGenerator<StreamEvent> {
    const [request, ctx] = args;
    const model = ctx.target.model;
    for await (const event of inner.create({ ...request, reasoningOrigin: codec.originFor(inner.kind, model) }, ctx)) {
      yield sealedEvent(event, model);
    }
  }

  return {
    kind: inner.kind,
    capabilities: (target) => inner.capabilities(target),
    create,
    classify: (error) => inner.classify(error),
    ...(countTokens === undefined ? {} : { countTokens: (request, ctx) => countTokens.call(inner, request, ctx) }),
    ...(countWire === undefined ? {} : { countWire: (wire, ctx) => countWire.call(inner, wire, ctx) }),
    ...(compact === undefined
      ? {}
      : { compact: (request, ctx) => compact.call(inner, { ...request, reasoningOrigin: codec.originFor(inner.kind, ctx.target.model) }, ctx) }),
    ...(renderWire === undefined
      ? {}
      : {
          renderWire: (request, target, options) =>
            renderWire.call(inner, { ...request, reasoningOrigin: codec.originFor(inner.kind, target.model) }, target, options),
        }),
    ...(renderCompactWire === undefined
      ? {}
      : {
          renderCompactWire: (request, target, cap) =>
            renderCompactWire.call(inner, { ...request, reasoningOrigin: codec.originFor(inner.kind, target.model) }, target, cap),
        }),
    ...(health === undefined ? {} : { health: (target) => health.call(inner, target) }),
    ...(close === undefined ? {} : { close: () => close.call(inner) }),
  };
};
