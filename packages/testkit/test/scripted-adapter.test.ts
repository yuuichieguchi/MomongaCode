import { describe, expect, it } from 'vitest';
import {
  ScriptedUpstreamError,
  createFakeClock,
  createFakeTimers,
  createScriptedAdapter,
  textResponseEvents,
  waitFor,
} from '@momonga/testkit';

const target = { name: 't', model: 'scripted-model' };
const request = { model: 'scripted-model', input: [] };

const collect = async (iterable: AsyncIterable<{ type: string }>): Promise<string[]> => {
  const types: string[] = [];
  for await (const event of iterable) types.push(event.type);
  return types;
};

describe('createScriptedAdapter', () => {
  it('emits the scripted events and records the call', async () => {
    const adapter = createScriptedAdapter({ calls: [{ events: textResponseEvents({ model: 'm', chunks: ['a'] }) }] });
    const controller = new AbortController();
    const types = await collect(adapter.create(request, { signal: controller.signal, target, attempt: 1, reasoningOrigin: { own: (item: unknown) => item as never } }));
    expect(types[0]).toBe('response.created');
    expect(types.at(-1)).toBe('response.completed');
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.calls[0]?.outcome).toBe('completed');
    expect(adapter.calls[0]?.emitted).toBe(types.length);
    expect(adapter.calls[0]?.request).toBe(request);
  });

  it('fails after the scripted events with a classified upstream error', async () => {
    const adapter = createScriptedAdapter({
      calls: [{ events: textResponseEvents({ model: 'm', chunks: ['a'] }).slice(0, 2), failure: { status: 503, message: 'down' } }],
    });
    const seen: string[] = [];
    const run = async (): Promise<void> => {
      for await (const event of adapter.create(request, { signal: new AbortController().signal, target, attempt: 1, reasoningOrigin: { own: (item: unknown) => item as never } })) seen.push(event.type);
    };
    const error = await run().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ScriptedUpstreamError);
    expect(seen).toEqual(['response.created', 'response.in_progress']);
    expect(adapter.classify(error)).toEqual({
      retryable: true,
      error: { type: 'server_error', code: 'upstream_error', message: 'down', param: null },
    });
  });

  it('classifies 429 with retryAfterMs, 4xx as non-retryable, and unknown errors as model_error', () => {
    const adapter = createScriptedAdapter({ calls: [] });
    expect(adapter.classify(new ScriptedUpstreamError({ status: 429, message: 'slow', retryAfterMs: 3000 }))).toEqual({
      retryable: true,
      retryAfterMs: 3000,
      error: { type: 'too_many_requests', code: 'rate_limited', message: 'slow', param: null },
    });
    expect(adapter.classify(new ScriptedUpstreamError({ status: 400, message: 'bad' })).retryable).toBe(false);
    expect(adapter.classify(new Error('boom')).error).toEqual({ type: 'model_error', code: 'adapter_error', message: 'boom', param: null });
  });

  it('keeps retryAfterMs on a retryable 5xx, as the upstream classifiers do', () => {
    const adapter = createScriptedAdapter({ calls: [] });
    expect(adapter.classify(new ScriptedUpstreamError({ status: 503, message: 'down', retryAfterMs: 20_000 }))).toEqual({
      retryable: true,
      retryAfterMs: 20_000,
      error: { type: 'server_error', code: 'upstream_error', message: 'down', param: null },
    });
  });

  it('blocks at a gate until released and aborts a gated call when its signal fires', async () => {
    const events = textResponseEvents({ model: 'm', chunks: ['a'] });
    const adapter = createScriptedAdapter({
      calls: [{ events, gate: { name: 'g', afterEvents: 1 } }, { events, gate: { name: 'never', afterEvents: 0 } }],
    });
    const first = collect(adapter.create(request, { signal: new AbortController().signal, target, attempt: 1, reasoningOrigin: { own: (item: unknown) => item as never } }));
    await waitFor(() => adapter.calls[0]?.emitted === 1);
    adapter.release('g');
    expect((await first).length).toBe(events.length);

    const controller = new AbortController();
    const second = collect(adapter.create(request, { signal: controller.signal, target, attempt: 1, reasoningOrigin: { own: (item: unknown) => item as never } }));
    await waitFor(() => adapter.calls.length === 2);
    controller.abort(new Error('closing'));
    await expect(second).rejects.toThrow('closing');
    expect(adapter.calls[1]?.outcome).toBe('aborted');
  });

  it('waits delayMs on the injected timers before the first event', async () => {
    const clock = createFakeClock(0);
    const timers = createFakeTimers(clock);
    const adapter = createScriptedAdapter({ timers, calls: [{ delayMs: 250, events: textResponseEvents({ model: 'm', chunks: ['a'] }) }] });
    const done = collect(adapter.create(request, { signal: new AbortController().signal, target, attempt: 1, reasoningOrigin: { own: (item: unknown) => item as never } }));
    await waitFor(() => timers.pending().length === 1);
    expect(timers.pending()[0]?.delayMs).toBe(250);
    expect(adapter.calls[0]?.emitted).toBe(0);
    timers.advance(250);
    expect((await done)[0]).toBe('response.created');
  });

  it('fails clearly when called more times than scripted', async () => {
    const adapter = createScriptedAdapter({ kind: 'k', calls: [] });
    await expect(collect(adapter.create(request, { signal: new AbortController().signal, target, attempt: 1, reasoningOrigin: { own: (item: unknown) => item as never } }))).rejects.toThrow(
      'scripted adapter k: no plan for call #1',
    );
  });

  it('exposes countTokens and compact only when scripted', async () => {
    const bare = createScriptedAdapter({ calls: [] });
    expect(bare.countTokens).toBeUndefined();
    expect(bare.compact).toBeUndefined();
    const full = createScriptedAdapter({
      calls: [],
      countTokens: { input_tokens: 42, method: 'exact', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } },
      compactSummary: 'summary text',
    });
    const ctx = { signal: new AbortController().signal, target, attempt: 1, reasoningOrigin: { own: (item: never) => item } };
    expect(await full.countTokens?.({ model: 'fast', input: 'hi' }, ctx)).toEqual({ input_tokens: 42, method: 'exact', error_bound: 0, error_shape: { ratio: 0, minimum: 0 } });
    expect((await full.compact?.({ model: 'scripted-model', input: [] }, ctx))?.summary).toBe('summary text');
    expect(full.countCalls).toHaveLength(1);
    expect(full.compactCalls).toHaveLength(1);
  });
});
