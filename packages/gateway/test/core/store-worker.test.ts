import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@momonga/protocol';
import { STORE_QUEUE_LENGTH, StoreWorkerError, openGatewayStore } from '../../src/core/store.ts';
import { STORE_WORKER_CODE } from '../../src/core/store-worker-code.generated.ts';
import { makeDir } from '../gateway-helpers.ts';
import { sleep, systemWaitTiming } from '@momonga/foundation';

const OPENS_THEN_SILENT = [
  "const { parentPort } = require('node:worker_threads');",
  "parentPort.on('message', (request) => { if (request.kind === 'open' || request.kind === 'close') parentPort.postMessage({ id: request.id, ok: true, value: null }); });",
].join('\n');

const framesOf = (bytes: number): StreamEvent[] => {
  const delta = 'x'.repeat(64 * 1024);
  const count = Math.ceil(bytes / delta.length);
  return [
    ...Array.from({ length: count }, (_, index): StreamEvent => ({ type: 'response.output_text.delta', sequence_number: index, item_id: 'msg_1', output_index: 0, content_index: 0, delta, logprobs: [] }) as StreamEvent),
  ];
};

const ticksUntil = async (work: Promise<unknown>): Promise<number> => {
  let settled = false;
  let ticks = 0;
  const watched = work.then(() => {
    settled = true;
  });
  while (!settled) {
    await sleep(systemWaitTiming, 0);
    ticks += 1;
  }
  await watched;
  return ticks;
};

const OPENS_ONLY = [
  "const { parentPort } = require('node:worker_threads');",
  "parentPort.on('message', (request) => { if (request.kind === 'open') parentPort.postMessage({ id: request.id, ok: true, value: null }); });",
].join('\n');

const OPEN = new AbortController().signal;

const openAt = (code: string) => openGatewayStore({ dbPath: path.join(makeDir(), 'gateway.db'), code, signal: OPEN });

describe('the gateway store runs off the event loop (C15)', () => {
  it('keeps the event loop turning while a 16 MiB keyed commit is written', async () => {
    const store = await openAt(STORE_WORKER_CODE);
    try {
      const commit = store.commit({ recordedAtMs: 1, idempotencyExpiredBeforeMs: 0, idempotency: { key: 'k', digest: 'd', frames: framesOf(16 * 1024 * 1024) } }, OPEN);
      expect(await ticksUntil(commit)).toBeGreaterThan(1);
    } finally {
      await store.close(OPEN);
    }
  });

  it('replays the frames of a keyed commit as they were written', async () => {
    const store = await openAt(STORE_WORKER_CODE);
    try {
      const frames = framesOf(256 * 1024);
      await store.commit({ recordedAtMs: 7, idempotencyExpiredBeforeMs: 0, idempotency: { key: 'k', digest: 'd', frames } }, OPEN);
      expect(await store.getIdempotency('k', OPEN)).toEqual({ digest: 'd', storedAtMs: 7, frames });
      await store.deleteIdempotency('k', OPEN);
      expect(await store.getIdempotency('k', OPEN)).toBeUndefined();
      expect(await store.recordSend({ callKey: 'c', target: 't', runId: null, step: null, sentAtMs: 1 }, OPEN)).toMatchObject({ retryOfSeq: undefined });
      const second = await store.recordSend({ callKey: 'c', target: 't', runId: null, step: null, sentAtMs: 2 }, OPEN);
      expect(second.retryOfSeq).toBeGreaterThan(0);
    } finally {
      await store.close(OPEN);
    }
  });

  it('refuses a stored row that fails validation, naming its place', async () => {
    const store = await openAt(STORE_WORKER_CODE);
    try {
      await store.commit({ recordedAtMs: 1, idempotencyExpiredBeforeMs: 0, idempotency: { key: 'bad', digest: 'd', frames: [{ type: 'no.such.event' } as unknown as StreamEvent] } }, OPEN);
      await expect(store.getIdempotency('bad', OPEN)).rejects.toThrow('gateway database table idempotency (key bad) column frames_json failed validation');
    } finally {
      await store.close(OPEN);
    }
  });

  it('ends a request the store thread does not answer when the signal of its asker aborts, with that reason', async () => {
    const store = await openAt(OPENS_THEN_SILENT);
    const asker = new AbortController();
    const read = store.getIdempotency('k', asker.signal);
    const reason = new Error('the asker left');
    asker.abort(reason);
    await expect(read).rejects.toBe(reason);
    await store.close(OPEN);
  });

  it('refuses a request beyond the bounded queue at once', async () => {
    const store = await openAt(OPENS_THEN_SILENT);
    const asker = new AbortController();
    const queued = Array.from({ length: STORE_QUEUE_LENGTH }, (_, index) => store.getIdempotency(`k${index}`, asker.signal));
    await expect(store.getIdempotency('one-more', asker.signal)).rejects.toThrow(StoreWorkerError);
    asker.abort(new Error('done'));
    await Promise.all(queued.map((request) => expect(request).rejects.toThrow('done')));
    await store.close(OPEN);
  });

  it('ends its thread at once when the close is forced, though the thread does not answer', async () => {
    const store = await openAt(OPENS_ONLY);
    const forced = new AbortController();
    const closed = store.close(forced.signal);
    forced.abort(new Error('forced'));
    await expect(closed).resolves.toBeUndefined();
  });
});
