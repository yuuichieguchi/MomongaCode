import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import type { Claim, RuntimeStore } from '@momonga/store';
import { startJournalThread } from '../../src/memory/journal-thread-client.ts';
import type { JournalThreadClient } from '../../src/memory/journal-thread-client.ts';
import { JOURNAL_THREAD_SILENCE_LIMIT_MS } from '../../src/memory/journal-thread-limits.ts';
import { openJournal } from '../../src/worker/journal.ts';
import type { Journal } from '../../src/worker/journal.ts';
import { answeredRun, chainBuilder, referenceHarness } from '../../../store/test/support/reference.ts';
import type { InheritPlanReply, InheritedWindowReply, PlanRequest, ReferenceHarness, WindowRequest } from '../../../store/test/support/reference.ts';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import { settle } from './inheritance-support.ts';
import { builderOf, harnessOf, referenceFactsOf } from './inherit-reference-support.ts';
import { UNASKED_COMMANDS } from '../../../store/test/support/unasked.ts';
import { testKernelLock } from '@momonga/testkit';

vi.setConfig({ testTimeout: 600_000 });

type ReferenceClient = JournalThreadClient & {
  inheritPlan(request: PlanRequest): Promise<InheritPlanReply>;
  inheritedWindow(request: WindowRequest): Promise<InheritedWindowReply>;
};

const clients: JournalThreadClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const threadOn = async (dbPath: string): Promise<ReferenceClient> => {
  const { dev, ino } = fs.statSync(dbPath);
  const client = await startJournalThread({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, lock: testKernelLock(), databasePath: dbPath, identity: { dev, ino }, silenceLimitMs: JOURNAL_THREAD_SILENCE_LIMIT_MS });
  clients.push(client);
  const candidate = client as Partial<ReferenceClient>;
  if (typeof candidate.inheritedWindow !== 'function') throw new Error('the journal thread client has no inheritedWindow');
  if (typeof candidate.inheritPlan !== 'function') throw new Error('the journal thread client has no inheritPlan');
  return client as ReferenceClient;
};

const serializedSize = (value: unknown): number => v8.serialize(value).length;

const STEP_COUNTS = [15, 50, 150, 1000] as const;
const CHAIN_LENGTHS = [1, 10, 100] as const;
const WINDOW: Omit<WindowRequest, 'runId'> = { windowTokens: 400, floorTokens: 1 };

const sourceWithChain = async (steps: number) => {
  const h = referenceHarness();
  const b = chainBuilder(h);
  await answeredRun(h, b, 'base task', (claim) => {
    for (let step = 0; step < steps; step += 1) b.text(claim, 300);
  }, { fresh: true });
  const links: string[] = [];
  for (let link = 1; link <= 100; link += 1) links.push((await answeredRun(h, b, `link ${link}`, (claim) => b.text(claim, 300))).id);
  const queued = b.createRun('queued child');
  return { h, links, queued };
};

const snapshotOfDb = (dbPath: string) => {
  const db = openDatabase(dbPath, { busyTimeoutMs: BUSY_WAIT_LIMIT_MS });
  try {
    return {
      events: db.prepare('SELECT count(*) AS n, max(id) AS last FROM events').get(),
      runs: db.prepare("SELECT group_concat(id || ':' || version || ':' || last_seq || ':' || status, ',') AS rows FROM (SELECT * FROM runs ORDER BY id)").get(),
    };
  } finally {
    db.close();
  }
};

describe('R6: what crosses the thread boundary is bounded by W and the item bound, not by the journal (P10)', () => {
  it('keeps the inherited_window reply size flat at 15, 50, 150 and 1000 steps and chain lengths 1, 10 and 100, and the inherit_plan reply flat across steps', async () => {
    const byLength = new Map<number, { sizes: number[]; counts: Set<number> }>(CHAIN_LENGTHS.map((length) => [length, { sizes: [], counts: new Set<number>() }]));
    const planSizes: number[] = [];
    for (const steps of STEP_COUNTS) {
      const { h, links, queued } = await sourceWithChain(steps);
      const client = await threadOn(h.dbPath);
      for (const length of CHAIN_LENGTHS) {
        const reply = await client.inheritedWindow({ runId: links[length - 1] as string, ...WINDOW });
        expect(reply.omittedOlder).toBe(true);
        expect(reply.entries.length).toBeLessThanOrEqual(WINDOW.windowTokens + 1);
        expect(serializedSize(reply)).toBeLessThan(32_000);
        byLength.get(length)?.counts.add(reply.entries.length);
        byLength.get(length)?.sizes.push(serializedSize(reply));
      }
      const plan = await client.inheritPlan({ runId: queued.id, mode: 'manual', unasked: UNASKED_COMMANDS });
      expect(plan).toMatchObject({ kind: 'ready', payload: { form: 'reference' } });
      planSizes.push(serializedSize(plan));
    }
    for (const [length, { sizes, counts }] of byLength) {
      expect(counts.size, `chain length ${length}`).toBe(1);
      expect(Math.max(...sizes) - Math.min(...sizes), `chain length ${length}`).toBeLessThan(256);
    }
    expect(Math.max(...planSizes) - Math.min(...planSizes)).toBeLessThan(256);
  });

  it('D2: an evicted output with a recorded token count crosses as a stub, never as its raw text', async () => {
    const h = referenceHarness();
    const b = chainBuilder(h);
    let callId = '';
    await answeredRun(h, b, 'one', (claim) => {
      callId = b.tool(claim, { outputChars: 30_000, evict: true });
      b.text(claim);
    }, { fresh: true });
    const child = b.createRun('child');
    await b.inherit(b.claimNext(child.id), 'manual');
    const client = await threadOn(h.dbPath);
    const reply = await client.inheritedWindow({ runId: child.id, windowTokens: 100_000, floorTokens: 1 });
    expect(reply.entries).toContainEqual({ seq: 3, callId, handle: h.store.blobs.handleFor(`out ${callId} ${'o'.repeat(30_000)}`), tokens: Math.ceil((`out ${callId} `.length + 30_000) / 4) });
    expect(serializedSize(reply)).toBeLessThan(4_000);
    expect(reply.evicted).toEqual([callId]);
  });
});

describe('R9: inherit_plan and inherited_window write nothing', () => {
  it('leaves the events and runs tables unchanged', async () => {
    const { h, links, queued } = await sourceWithChain(15);
    const before = snapshotOfDb(h.dbPath);
    const client = await threadOn(h.dbPath);
    await client.inheritPlan({ runId: queued.id, mode: 'manual', unasked: UNASKED_COMMANDS });
    await client.inheritedWindow({ runId: links[9] as string, ...WINDOW });
    await client.inheritPlan({ runId: queued.id, mode: 'plan', unasked: UNASKED_COMMANDS });
    expect(snapshotOfDb(h.dbPath)).toEqual(before);
  });
});

const loopDecodeDuringInheritance = async (steps: number) => {
  const decoded = { rows: 0, bytes: 0, counting: false };
  const env = await makeEnv({
    onDecode: (rows, bytes) => {
      if (!decoded.counting) return;
      decoded.rows += rows;
      decoded.bytes += bytes;
    },
  });
  const b = builderOf(env);
  const source = b.createRun('base task', { history: 'fresh' });
  const claim = b.claimNext(source.id);
  b.started(claim, 'manual');
  for (let step = 0; step < steps; step += 1) b.text(claim, 20);
  await b.end(claim, { to: 'COMPLETED' });
  const child = b.createRun('child task');
  const counted = <T,>(work: () => Promise<T>): Promise<T> => {
    decoded.counting = true;
    return work().finally(() => {
      decoded.counting = false;
    });
  };
  const facts = referenceFactsOf(env.store);
  const watched: RuntimeStore = new Proxy(env.store, {
    get: (target, key, receiver) => {
      if (key === 'inheritContext') return (claimed: Claim, options: { mode: 'manual' }) => counted(async () => target.inheritContext(claimed, options));
      if (key === 'journalFacts') {
        return {
          ...target.journalFacts,
          inheritPlan: (request: PlanRequest) => counted(() => facts.inheritPlan(request)),
          inheritedWindow: (request: WindowRequest) => counted(() => facts.inheritedWindow(request)),
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  env.gateway.script.push(textStep('Done.'));
  await settle(env, child.id, env.worker('worker-1', { store: watched }));
  expect(env.run(child.id).status).toBe('COMPLETED');
  return { env, decoded, sourceId: source.id };
};

describe('R8: the loop decodes no history for inheritance (count form of section 7)', () => {
  it('decodes zero rows on the loop while planning, committing and reading the window, at 15 and 1000 steps', async () => {
    for (const steps of [15, 1000]) {
      const { decoded } = await loopDecodeDuringInheritance(steps);
      expect(decoded, `${steps} steps`).toEqual({ rows: 0, bytes: 0, counting: false });
    }
  });

  it('pi-style control: the same read through an inline double on the loop decodes rows that grow with the run', async () => {
    const counts: number[] = [];
    for (const steps of [15, 1000]) {
      const { env, decoded, sourceId } = await loopDecodeDuringInheritance(steps);
      decoded.counting = true;
      inlineWindowOnLoop(env, sourceId);
      decoded.counting = false;
      counts.push(decoded.rows);
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBeGreaterThan(10 * (counts[0] as number));
  });
});

const inlineWindowOnLoop = (env: Env, runId: string): number => {
  let items = 0;
  for (let after = 0; ; ) {
    const page = env.store.readRunEvents(runId, after, 1000);
    items += page.filter((event) => event.type === 'user.message' || event.type === 'model.responded').length;
    if (page.length < 1000) return items;
    after = page.at(-1)?.seq ?? after;
  }
};

const childSnapshotBytes = async (steps: number): Promise<number> => {
  const env = await makeEnv();
  const b = builderOf(env);
  const source = b.createRun('base task', { history: 'fresh' });
  const claim = b.claimNext(source.id);
  b.started(claim, 'manual');
  for (let step = 0; step < steps; step += 1) b.text(claim, 20);
  await b.end(claim, { to: 'COMPLETED' });
  const child = b.createRun('child task');
  env.gateway.script.push(callsStep([{ callId: 'call_w_1', name: 'Write', args: { file_path: path.join(env.project, 'out.txt'), content: 'approved' } }]));
  expect(await env.runOnce(env.worker('worker-1'))).toBe('yielded');
  expect(env.run(child.id).status).toBe('WAITING_HUMAN');
  const row = env.raw().prepare('SELECT state_json FROM snapshots WHERE run_id = ? ORDER BY seq DESC LIMIT 1').get(child.id) as { state_json: string } | undefined;
  if (row === undefined) throw new Error(`run ${child.id} has no snapshot`);
  return Buffer.byteLength(row.state_json);
};

describe('R13: a snapshot never holds the window', () => {
  it('the snapshot a child writes at its yield is the same size whether its source has 15 or 1000 steps', async () => {
    const small = await childSnapshotBytes(15);
    const large = await childSnapshotBytes(1000);
    expect(Math.abs(large - small)).toBeLessThan(256);
  });
});

type WindowedJournal = Journal & { installWindow(reply: InheritedWindowReply): void };

const windowed = (journal: Journal): WindowedJournal => {
  if (typeof (journal as Partial<WindowedJournal>).installWindow !== 'function') throw new Error('the journal has no installWindow');
  return journal as WindowedJournal;
};

describe('R14: no history is read before the window is installed', () => {
  const committedChild = async () => {
    const env = await makeEnv();
    const h: ReferenceHarness = harnessOf(env);
    const b = builderOf(env);
    await answeredRun(h, b, 'Say hello', (claim) => b.text(claim), { fresh: true });
    const child = b.createRun('And again');
    const claim = b.claimNext(child.id);
    expect(await env.store.inheritContext(claim, { mode: 'manual' })).toEqual({ kind: 'inherited' });
    const journal = openJournal({
      store: env.store,
      claim,
      lost: () => {
        throw new Error('lease lost');
      },
    });
    return { env, child, claim, journal };
  };

  it('the merged history throws before install and holds the window and the own items after', async () => {
    const { env, child, journal } = await committedChild();
    const subject = windowed(journal);
    expect(() => subject.state.history).toThrow(/window/);
    const reply = await referenceFactsOf(env.store).inheritedWindow({ runId: child.id, windowTokens: 100_000, floorTokens: 1 });
    subject.installWindow(reply);
    expect(subject.state.history.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(subject.state.taskSeq).toBe(3);
  });

  it('the snapshot the journal writes holds the own items only', async () => {
    const { env, child, journal } = await committedChild();
    const subject = windowed(journal);
    subject.installWindow(await referenceFactsOf(env.store).inheritedWindow({ runId: child.id, windowTokens: 100_000, floorTokens: 1 }));
    subject.snapshot();
    const row = env.raw().prepare('SELECT state_json FROM snapshots WHERE run_id = ? ORDER BY seq DESC LIMIT 1').get(child.id) as { state_json: string };
    const stored = JSON.parse(row.state_json) as { history: { seq: number }[] };
    expect(stored.history.map((entry) => entry.seq)).toEqual([3]);
  });
});
