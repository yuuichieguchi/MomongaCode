import { describe, expect, it } from 'vitest';
import { HOST_READ_BOUND_MS, OperationLimitError } from '@momonga/foundation';
import type { LimitTiming } from '@momonga/foundation';
import { SETTINGS_CHANGE_LIMIT_LABEL, settingsChangeWithin, writtenEntryOf } from './plan-real-check-settings.ts';

const document = {
  models: {
    connections: [
      { adapter: 'open-responses', provider: 'second', baseUrl: 'http://127.0.0.1:9002', models: [{ id: 'other' }, { id: 'wanted', capabilities: { reasoning: 'second' } }] },
      { adapter: 'open-responses', provider: 'first', baseUrl: 'http://127.0.0.1:9001', models: [{ id: 'wanted', capabilities: { reasoning: 'first' } }] },
    ],
  },
};

describe('the written entry of a resolved model', () => {
  it('is found by the provider and the id, whatever order the file and the resolved models have', () => {
    expect(writtenEntryOf(document, { provider: 'first', ownName: 'wanted' })).toEqual({ id: 'wanted', capabilities: { reasoning: 'first' } });
    expect(writtenEntryOf(document, { provider: 'second', ownName: 'wanted' })).toEqual({ id: 'wanted', capabilities: { reasoning: 'second' } });
  });

  it('matches an id written without the default tag of its server to the tagged name', () => {
    const tagged = { models: { connections: [{ adapter: 'ollama', provider: 'local', models: [{ id: 'qwen3' }] }] } };
    expect(writtenEntryOf(tagged, { provider: 'local', ownName: 'qwen3:latest', defaultTag: 'latest' })).toEqual({ id: 'qwen3' });
  });

  it('refuses a model that has no written entry, naming it', () => {
    expect(() => writtenEntryOf(document, { provider: 'first', ownName: 'absent' })).toThrow('the settings have no model entry absent in the connection first');
  });
});

describe('the settings change of the real check', () => {
  const manualTiming = (): LimitTiming & { fire(): void; delays: number[] } => {
    let pending: (() => void) | undefined;
    const delays: number[] = [];
    return {
      delays,
      setTimeout: ((callback: () => void, delay: number) => {
        pending = callback;
        delays.push(delay);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as LimitTiming['setTimeout'],
      clearTimeout: () => {
        pending = undefined;
      },
      fire: () => pending?.(),
    };
  };

  it('runs under the operation limit of the host read bound, and the limit ends the change', async () => {
    const timing = manualTiming();
    let seen: AbortSignal | undefined;
    const change = settingsChangeWithin(new AbortController().signal, (signal) => {
      seen = signal;
      return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    }, timing);
    expect(timing.delays).toEqual([HOST_READ_BOUND_MS]);
    timing.fire();
    await expect(change).rejects.toBeInstanceOf(OperationLimitError);
    expect(seen?.aborted).toBe(true);
    expect((seen?.reason as OperationLimitError).label).toBe(SETTINGS_CHANGE_LIMIT_LABEL);
  });

  it('ends with the interrupt of the script', async () => {
    const interrupt = new AbortController();
    const change = settingsChangeWithin(interrupt.signal, (signal) => new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })), manualTiming());
    interrupt.abort(new Error('interrupted'));
    await expect(change).rejects.toThrow('interrupted');
  });
});
