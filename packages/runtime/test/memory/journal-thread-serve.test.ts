import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { serveJournalReader } from '../../src/memory/journal-thread.ts';
import { afterMicrotasks } from '@momonga/testkit';

const turn = afterMicrotasks;

const fakeChannel = (): { incoming: EventEmitter; outgoing: { postMessage(message: unknown): void }; sent: unknown[] } => {
  const sent: unknown[] = [];
  return { incoming: new EventEmitter(), outgoing: { postMessage: (message) => sent.push(structuredClone(message)) }, sent };
};

describe('serveJournalReader', () => {
  it('keeps the request id and ok true over id and ok fields returned by a handler', async () => {
    const channel = fakeChannel();
    serveJournalReader({ spoof: () => ({ id: 999, ok: false, value: 1 }) }, channel);
    channel.incoming.emit('message', { id: 4, kind: 'spoof' });
    await turn();
    expect(channel.sent).toEqual([{ id: 4, ok: true, value: 1 }]);
  });

  it('turns a reply that cannot be cloned into exactly one request error naming the clone failure, then keeps serving', async () => {
    const channel = fakeChannel();
    serveJournalReader({ uncloneable: () => ({ f: () => 1 }), echo: (request: Readonly<Record<string, unknown>>) => ({ echoed: request['value'] }) }, channel);
    channel.incoming.emit('message', { id: 5, kind: 'uncloneable' });
    await turn();
    channel.incoming.emit('message', { id: 6, kind: 'echo', value: 'next' });
    await turn();
    expect(channel.sent).toEqual([
      { id: 5, ok: false, error: { name: 'DataCloneError', message: expect.any(String) } },
      { id: 6, ok: true, echoed: 'next' },
    ]);
  });

  it.each([
    ['no numeric id', { kind: 'ping' }],
    ['no string kind', { id: 1 }],
  ])('throws synchronously and posts nothing for a message with %s', async (_label, message) => {
    const channel = fakeChannel();
    serveJournalReader({ ping: () => ({}) }, channel);
    expect(() => channel.incoming.emit('message', message)).toThrow();
    await turn();
    expect(channel.sent).toEqual([]);
  });

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
