import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { serveJournalReader } from '../../src/memory/journal-thread.ts';

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const fakeChannel = (): { incoming: EventEmitter; outgoing: { postMessage(message: unknown): void }; sent: unknown[] } => {
  const sent: unknown[] = [];
  return { incoming: new EventEmitter(), outgoing: { postMessage: (message) => sent.push(message) }, sent };
};

describe('serveJournalReader', () => {
  it('answers a registered kind with the handler reply fields under the request id', async () => {
    const channel = fakeChannel();
    serveJournalReader({ echo: (request: Readonly<Record<string, unknown>>) => ({ echoed: request['value'] }) }, channel);
    channel.incoming.emit('message', { id: 7, kind: 'echo', value: 'hello' });
    await turn();
    expect(channel.sent).toEqual([{ id: 7, ok: true, echoed: 'hello' }]);
  });

  it('answers an unknown kind with a request error naming the kind', async () => {
    const channel = fakeChannel();
    serveJournalReader({ ping: () => ({}) }, channel);
    channel.incoming.emit('message', { id: 3, kind: 'contribution' });
    await turn();
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]).toMatchObject({ id: 3, ok: false, error: { name: expect.any(String), message: expect.stringContaining('contribution') } });
  });

  it('answers a throwing handler with ok false carrying its name and message, then keeps serving', async () => {
    const channel = fakeChannel();
    serveJournalReader(
      {
        broken: () => {
          throw new RangeError('measure failed');
        },
        echo: (request: Readonly<Record<string, unknown>>) => ({ echoed: request['value'] }),
      },
      channel,
    );
    channel.incoming.emit('message', { id: 1, kind: 'broken' });
    await turn();
    channel.incoming.emit('message', { id: 2, kind: 'echo', value: 'still here' });
    await turn();
    expect(channel.sent).toEqual([
      { id: 1, ok: false, error: { name: 'RangeError', message: 'measure failed' } },
      { id: 2, ok: true, echoed: 'still here' },
    ]);
  });
});
