import fs from 'node:fs';
import path from 'node:path';
import { afterEach } from 'vitest';
import { openRuntimeStore } from '@momonga/store';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import type { RuntimeStore, RuntimeStoreOptions } from '@momonga/store';
import { createFakeClock, NEVER_CANCELLED } from '@momonga/testkit';
import { startJournalThread } from '../../src/memory/journal-thread-client.ts';
import type { JournalThreadClient } from '../../src/memory/journal-thread-client.ts';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../../src/memory/journal-thread-limits.ts';
import { START_MS, enqueue, makeStoreDir, newSession, registerCleanup } from '../../../store/test/helpers.ts';
import { finishClaimed } from './reflection-fixture.ts';
import { UNASKED_COMMANDS } from '../../../store/test/support/unasked.ts';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';

export const SHA = 'a'.repeat(64);

export const HEAD = '0123456789abcdef0123456789abcdef01234567';

export type RunFactsClient = JournalThreadClient & {
  verdict(request: { runId: string; commands: readonly string[]; manifests: readonly string[] }): Promise<Readonly<Record<string, unknown>>>;
  evidence(request: { runId: string; paths: readonly string[]; onlyCommand?: string }): Promise<Readonly<Record<string, unknown>>>;
  reflectionInput(request: { runId: string; project: string; capabilities: unknown }): Promise<Readonly<Record<string, unknown>>>;
  inheritPlan(request: { runId: string; mode: string }): Promise<Readonly<Record<string, unknown>>>;
  inheritedWindow(request: { runId: string; windowTokens: number; floorTokens: number }): Promise<Readonly<Record<string, unknown>>>;
};

type Preparer = NonNullable<RuntimeStoreOptions['preparer']>;

const METHODS = ['measure', 'inheritPlan', 'inheritedWindow', 'verdict', 'evidence', 'reflectionInput', 'fidelity'] as const;

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

export type ThreadOverride =Partial<Record<(typeof METHODS)[number], (request: never) => Promise<unknown>>>;

export const lazyThread = (dbPath: () => string, override: ThreadOverride = {}) => {
  let started: Promise<RunFactsClient> | undefined;
  const client = (): Promise<RunFactsClient> => {
    started ??= (() => {
      const databasePath = dbPath();
      const { dev, ino } = fs.statSync(databasePath);
      return startJournalThread({ databasePath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS }) as Promise<RunFactsClient>;
    })();
    return started;
  };
  const forwarded = Object.fromEntries(
    METHODS.map((method) => [
      method,
      async (request: never) => {
        const replaced = override[method];
        if (replaced !== undefined) return replaced(request);
        const live = (await client()) as unknown as Record<string, ((request: never) => Promise<unknown>) | undefined>;
        const target = live[method];
        if (target === undefined) throw new Error(`the journal thread client has no method ${method}`);
        return target.call(live, request);
      },
    ]),
  );
  closers.push(async () => {
    if (started !== undefined) await (await started).close();
  });
  return { preparer: forwarded as unknown as Preparer, client };
};

export const factsStore = async (override: ThreadOverride = {}) => {
  const dir = makeStoreDir();
  const dbPath = path.join(dir, 'runtime.db');
  const clock = createFakeClock(START_MS);
  const decoded = { rows: 0, bytes: 0 };
  const thread = lazyThread(() => dbPath, override);
  const store: RuntimeStore = openRuntimeStore({ fileSystem: nodeFileSystem, random: systemRandom, unaskedCommands: UNASKED_COMMANDS,
    path: dbPath,
    home: dir,
    clock,
    leaseMs: 30_000,
    maxAttempts: 5,
    maxTotalAttempts: 1000,
    preparer: thread.preparer,
    onDecode: (rows, bytes) => {
      decoded.rows += rows;
      decoded.bytes += bytes;
    },
  });
  registerCleanup(() => store.close());
  const project = fs.realpathSync(makeStoreDir());
  await store.trust.setAsked(project, 'trusted', NEVER_CANCELLED);
  const session = newSession(store, project);
  const finished = async (events: readonly RunEventPayload[], outcome: 'COMPLETED' | 'FAILED' = 'COMPLETED', input = 'fix the bug') => {
    const run = await enqueue(store, session.id, input);
    await finishClaimed(store, events, outcome);
    return run;
  };
  const allEvents = (runId: string): RunEvent[] => store.readRunEvents(runId, 0, 1_000_000);
  const decodedDuring = async <T>(work: () => Promise<T>): Promise<{ value: T; rows: number; bytes: number }> => {
    const before = { ...decoded };
    const value = await work();
    return { value, rows: decoded.rows - before.rows, bytes: decoded.bytes - before.bytes };
  };
  return { dir, dbPath, clock, store, project, session, finished, allEvents, decodedDuring, client: thread.client };
};

export const seqOf = (events: readonly RunEvent[], type: RunEvent['type'], callId: string): number => {
  const found = events.find((event) => event.type === type && 'callId' in event && event.callId === callId);
  if (found === undefined) throw new Error(`no ${type} event for ${callId}`);
  return found.seq;
};
