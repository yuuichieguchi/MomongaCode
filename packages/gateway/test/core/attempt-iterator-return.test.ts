import { describe, expect, it } from 'vitest';
import type { AdapterContext, AdapterRequest, StreamEvent } from '@momonga/protocol';
import { createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { postJson, readJson, startGateway, userInput } from '../gateway-helpers.ts';

const retryableFailedEvent = (): StreamEvent => {
  const base = textResponseEvents({ model: 'scripted-primary', chunks: ['x'] });
  const last = base[base.length - 1];
  if (last === undefined || last.type !== 'response.completed') throw new Error('fixture shape');
  return {
    type: 'response.failed',
    sequence_number: 0,
    response: { ...last.response, status: 'failed', error: { code: 'server_exploded', message: 'boom' } },
  };
};

describe('a started iterator is returned on every exit path of the attempt', () => {
  it('returns the iterator once and runs its finally when the first event is a retryable failure', async () => {
    const seen = { returns: 0, finallyRan: 0 };
    const base = createScriptedAdapter({ calls: [] });
    async function* failing(): AsyncGenerator<StreamEvent> {
      try {
        yield retryableFailedEvent();
        yield retryableFailedEvent();
      } finally {
        seen.finallyRan += 1;
      }
    }
    const adapter = {
      ...base,
      create: (_request: AdapterRequest, _ctx: AdapterContext): AsyncIterable<StreamEvent> => ({
        [Symbol.asyncIterator]: () => {
          const inner = failing();
          return {
            next: () => inner.next(),
            return: (value?: unknown) => {
              seen.returns += 1;
              return inner.return(value);
            },
          };
        },
      }),
    };
    const harness = await startGateway({ adapters: { 'scripted/scripted-primary': adapter }, config: { retry: { maxAttempts: 1, totalWaitMs: 1 } } });
    const response = await readJson(await postJson(harness.client, '/v1/responses', { model: 'scripted/scripted-primary', input: userInput('hi') }));
    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(seen.returns).toBe(1);
    expect(seen.finallyRan).toBe(1);
  });
});
