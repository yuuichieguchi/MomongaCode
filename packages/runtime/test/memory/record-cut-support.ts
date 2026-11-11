import fs from 'node:fs';
import { afterEach } from 'vitest';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import type { ClaimedToken, RunEvent } from '@momonga/protocol';
import { blobDirectoryOf, createBlobStore, createJournalReader } from '@momonga/store';
import { openJournalConnection, fidelityHandler } from '../../src/memory/journal-thread.ts';
import { startJournalThread } from '../../src/memory/journal-thread-client.ts';
import type { JournalThreadClient } from '../../src/memory/journal-thread-client.ts';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../../src/memory/journal-thread-limits.ts';
import { FIDELITY_EVENT_TYPES, createFidelityFold } from '../../src/memory/fidelity-fold.ts';
import { eventsOf } from '../../../store/test/support/reference.ts';
import type { ReferenceHarness } from '../../../store/test/support/reference.ts';
import { mustRun } from '../../../store/test/helpers.ts';
import type { FidelityReply } from './fidelity-fixture.ts';

const clients: JournalThreadClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

export const CWD = '/work/a';

export type FidelityRequest = { runId: string; throughEventSeq?: number; cwd?: string; tokens: readonly ClaimedToken[] };

const requestOf = (h: ReferenceHarness, request: FidelityRequest) => ({
  kind: 'fidelity',
  runId: request.runId,
  throughEventSeq: request.throughEventSeq ?? mustRun(h.store, request.runId).lastSeq,
  cwd: request.cwd ?? CWD,
  tokens: request.tokens.map((entry) => ({ ...entry })),
});

export const threadOf = async (h: ReferenceHarness): Promise<JournalThreadClient> => {
  const { dev, ino } = fs.statSync(h.dbPath);
  const client = await startJournalThread({ databasePath: h.dbPath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS, blobsDir: blobDirectoryOf(h.dbPath) } as Parameters<typeof startJournalThread>[0]);
  clients.push(client);
  return client;
};

export const threadFidelity = async (h: ReferenceHarness, request: FidelityRequest): Promise<FidelityReply> =>
  (await (await threadOf(h)).request(requestOf(h, request))) as unknown as FidelityReply;

const NO_CLOCK = {
  now: (): number => {
    throw new Error('the fidelity check has no clock');
  },
};

export const directFidelity = async (h: ReferenceHarness, request: FidelityRequest): Promise<{ reply: FidelityReply; stepped: number }> => {
  const db = openJournalConnection(h.dbPath);
  let stepped = 0;
  try {
    const reader = createJournalReader(db, {
      onRowsStepped: (rows) => {
        stepped += rows;
      },
    });
    const handler = fidelityHandler({ reader, blobs: createBlobStore(db, NO_CLOCK, blobDirectoryOf(h.dbPath), { fileSystem: nodeFileSystem, random: systemRandom }), current: { progress: undefined }, gateFor: () => ({ unit: () => undefined }) });
    const reply = (await handler(requestOf(h, request), () => undefined)) as unknown as FidelityReply;
    return { reply, stepped };
  } finally {
    db.close();
  }
};

type Hop = { runId: string; bound: number; omitsTask: boolean };

type ReferenceLink = { form?: string; fromRunId: string; fromLastSeq: number; omitSeqs?: number[]; via?: { runId: string; lastSeq: number; omitSeqs: number[] }[] };

const inheritedOf = (events: readonly RunEvent[]): (RunEvent & ReferenceLink) | undefined =>
  events.find((event) => event.type === 'context.inherited') as (RunEvent & ReferenceLink) | undefined;

export const chainHops = (h: ReferenceHarness, runId: string): Hop[] => {
  const hops: Hop[] = [{ runId, bound: mustRun(h.store, runId).lastSeq, omitsTask: false }];
  let current = runId;
  for (;;) {
    const link = inheritedOf(eventsOf(h.store, current));
    if (link === undefined || link.form !== 'reference') return hops.reverse();
    for (const via of link.via ?? []) hops.push({ runId: via.runId, bound: via.lastSeq, omitsTask: via.omitSeqs.length > 0 });
    hops.push({ runId: link.fromRunId, bound: link.fromLastSeq, omitsTask: (link.omitSeqs ?? []).length > 0 });
    current = link.fromRunId;
  }
};

export const concatenatedEvents = (h: ReferenceHarness, runId: string): RunEvent[] =>
  chainHops(h, runId).flatMap((hop) => {
    const events = eventsOf(h.store, hop.runId).filter((event) => event.seq <= hop.bound && (FIDELITY_EVENT_TYPES as readonly string[]).includes(event.type));
    const task = events.find((event) => event.type === 'user.message');
    return events.filter((event) => !(hop.omitsTask && event === task) && !(event.type === 'context.inherited' && (event as RunEvent & ReferenceLink).form === 'reference'));
  });

export const oracleAttested = (h: ReferenceHarness, runId: string, tokens: readonly ClaimedToken[], cwd = CWD): string[] => {
  const withPort = createFidelityFold as unknown as (tokens: readonly ClaimedToken[], cwd: string, record: (event: RunEvent) => void) => ReturnType<typeof createFidelityFold>;
  const fold = withPort(tokens, cwd, () => {
    throw new Error('the oracle holds no reference event');
  });
  for (const event of concatenatedEvents(h, runId)) fold.add(event);
  fold.finish();
  return [...fold.attested()].sort();
};

export const chainBound = (h: ReferenceHarness, runId: string): number => chainHops(h, runId).reduce((sum, hop) => sum + hop.bound, 0);
