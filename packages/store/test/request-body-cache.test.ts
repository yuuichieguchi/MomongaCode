import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { openRuntimeStore } from '@momonga/store';
import type { Claim, RuntimeStore } from '@momonga/store';
import { createFakeClock } from '@momonga/testkit';
import { decodeRunEvents } from '../src/codec.ts';
import { LEASE_MS, START_MS, enqueue, makeStoreDir, mustClaim, newSession, rawDb, registerCleanup, UNASKED_COMMANDS } from './helpers.ts';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';

const READERS_PER_STEP = 4;

const requestedWith = (step: number, text: string): RunEventPayload =>
  ({
    type: 'model.requested',
    step,
    attempt: 1,
    digest: `d${step}`,
    body: { model: 'fm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }] },
  }) as RunEventPayload;

const responded = (step: number): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
});

const FIRST_TEXT = `first request ${'alpha '.repeat(4_000)}`;
const SECOND_TEXT = `second request ${'beta '.repeat(5_000)}`;

type Decodes = { rows: number; counting: boolean };

const countingStore = async () => {
  const dbPath = path.join(makeStoreDir(), 'runtime.db');
  const clock = createFakeClock(START_MS);
  const decodes: Decodes = { rows: 0, counting: false };
  const store: RuntimeStore = openRuntimeStore({ fileSystem: nodeFileSystem, random: systemRandom, unaskedCommands: UNASKED_COMMANDS,
    path: dbPath,
    home: path.dirname(dbPath),
    clock,
    leaseMs: LEASE_MS,
    maxAttempts: 5,
    maxTotalAttempts: 1000,
    onDecode: (rows) => {
      if (decodes.counting) decodes.rows += rows;
    },
  });
  registerCleanup(() => store.close());
  const run = await enqueue(store, newSession(store).id);
  const claim = mustClaim(store, 'w1');
  expect(store.append(claim, [requestedWith(1, FIRST_TEXT)]).kind).toBe('ok');
  const counted = <T>(read: () => T): { value: T; rows: number } => {
    decodes.rows = 0;
    decodes.counting = true;
    try {
      return { value: read(), rows: decodes.rows };
    } finally {
      decodes.counting = false;
    }
  };
  const lastSeq = (): number => store.getRun(run.id)?.lastSeq ?? -1;
  return { dbPath, clock, store, run, claim, counted, lastSeq };
};

const uncachedLatest = (dbPath: string, runId: string, type: string, beforeSeq: number) => {
  const rows = rawDb(dbPath).prepare('SELECT * FROM events WHERE run_id = :runId AND type = :type AND seq < :beforeSeq ORDER BY seq DESC LIMIT 1').all({ runId, type, beforeSeq });
  return decodeRunEvents(rows)[0];
};

const latestRequest = (store: RuntimeStore, runId: string, beforeSeq: number) => store.readLatestRunEventBefore(runId, 'model.requested', beforeSeq);

const textOf = (event: ReturnType<typeof latestRequest>): string => {
  const body = event?.body as { input: { content: { text: string }[] }[] } | undefined;
  return body?.input[0]?.content[0]?.text ?? '';
};

describe('the recorded request body is decoded once per step under a claim (row 9)', () => {
  it('four readers of the latest request in one step decode the body once, and each gets what an uncached read returns', async () => {
    const { dbPath, store, run, counted, lastSeq } = await countingStore();
    const before = lastSeq() + 1;

    const { value: reads, rows } = counted(() => Array.from({ length: READERS_PER_STEP }, () => latestRequest(store, run.id, before)));

    expect(rows).toBe(1);
    const uncached = uncachedLatest(dbPath, run.id, 'model.requested', before);
    expect(uncached?.type).toBe('model.requested');
    for (const read of reads) expect(read).toEqual(uncached);
    expect(textOf(reads[0])).toBe(FIRST_TEXT);
  });

  it('a read of another type is not answered from the cached request', async () => {
    const { store, claim, run, counted, lastSeq } = await countingStore();
    expect(store.append(claim, [responded(1)]).kind).toBe('ok');
    const before = lastSeq() + 1;
    counted(() => latestRequest(store, run.id, before));

    const { value: response } = counted(() => store.readLatestRunEventBefore(run.id, 'model.responded', before));
    const { value: request, rows } = counted(() => latestRequest(store, run.id, before));

    expect(response?.type).toBe('model.responded');
    expect(response?.seq).toBe(before - 1);
    expect(request?.type).toBe('model.requested');
    expect(rows).toBe(0);
  });

  it('a new model.requested makes the next read return the new body, decoded once, while a read before it still returns the old one', async () => {
    const { dbPath, store, claim, run, counted, lastSeq } = await countingStore();
    const firstBefore = lastSeq() + 1;
    counted(() => latestRequest(store, run.id, firstBefore));
    expect(store.append(claim, [responded(1), requestedWith(2, SECOND_TEXT)]).kind).toBe('ok');
    const secondBefore = lastSeq() + 1;

    const { value: reads, rows } = counted(() => Array.from({ length: READERS_PER_STEP }, () => latestRequest(store, run.id, secondBefore)));
    const old = latestRequest(store, run.id, firstBefore);

    expect(rows).toBe(1);
    for (const read of reads) expect(read).toEqual(uncachedLatest(dbPath, run.id, 'model.requested', secondBefore));
    expect(textOf(reads[0])).toBe(SECOND_TEXT);
    expect(old).toEqual(uncachedLatest(dbPath, run.id, 'model.requested', firstBefore));
    expect(textOf(old)).toBe(FIRST_TEXT);
  });

  it('the cache does not outlive the claim: the next claim of the run decodes the body again', async () => {
    const { clock, store, run, counted, lastSeq } = await countingStore();
    const before = lastSeq() + 1;
    expect(counted(() => latestRequest(store, run.id, before)).rows).toBe(1);
    clock.advance(LEASE_MS + 1);
    const next: Claim = mustClaim(store, 'w2');
    expect(next.runId).toBe(run.id);

    const { value: read, rows } = counted(() => latestRequest(store, run.id, lastSeq() + 1));

    expect(rows).toBe(1);
    expect(textOf(read)).toBe(FIRST_TEXT);
  });
});
