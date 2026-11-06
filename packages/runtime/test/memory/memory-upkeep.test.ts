import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import type { MemoryEvidence } from '@momonga/protocol';
import { afterMicrotasks, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { START_MS, callEvent, enqueue, harness, makeStoreDir, mustClaim, newSession, recalled } from '../../../store/test/helpers.ts';
import { beginUpkeepPass, runMemoryUpkeep } from '../../src/memory/upkeep.ts';
import { createMemoryUpkeepSchedule } from '../../src/memory/upkeep-schedule.ts';
import { createRecordViews } from '../../src/memory/views.ts';
import { exported } from './reflection-fixture.ts';

const FORGET_MS = 7_776_000_000;
const SIGNAL = new AbortController().signal;

const setup = (calls = 12) => {
  const { store, clock } = harness();
  const project = fs.realpathSync.native(makeStoreDir());
  store.trust.set(project, 'trusted');
  const run = enqueue(store, newSession(store, project).id);
  const callIds = Array.from({ length: calls }, (_unused, index) => `c${index}`);
  expect(store.append(mustClaim(store, 'w1'), callIds.map(callEvent)).kind).toBe('ok');
  const free = [...callIds];
  const saveAt = (where: string, text: string, evidence: MemoryEvidence[] = [], origin: 'trusted' | 'untrusted' = 'trusted') => {
    const callId = free.shift();
    if (callId === undefined) throw new Error('out of calls');
    clock.advance(1);
    return store.memories.save({ origin, scope: 'project', project: where, text, runId: run.id, step: 1, callId, evidence }).memory;
  };
  const save = (text: string, evidence: MemoryEvidence[] = [], origin: 'trusted' | 'untrusted' = 'trusted') => saveAt(project, text, evidence, origin);
  const views = createRecordViews({ store, evidenceRun: () => async () => ({ exitCode: null }) });
  const upkeep = (batchSize = 100): Promise<{ duplicates: number; archived: number }> =>
    exported<(options: unknown) => Promise<{ duplicates: number; archived: number }>>('runMemoryUpkeep')({ store, clock, views, forgetAfterDays: async () => 90, batchSize, signal: SIGNAL });
  const fileEvidence = (name: string, recordedText: string): MemoryEvidence[] => {
    fs.writeFileSync(path.join(project, name), 'current');
    return [{ kind: 'file', project, path: name, sha256: sha256Hex(recordedText) }];
  };
  return { store, clock, project, run, save, saveAt, upkeep, fileEvidence, views };
};

describe('runMemoryUpkeep', () => {
  it('marks the newer of two equal notes and keeps the older', async () => {
    const { store, save, upkeep } = setup();
    const older = save('run the seed script first');
    const newer = save('run the seed script first');
    expect(await upkeep()).toMatchObject({ duplicates: 1 });
    expect(store.memories.get(newer.id)).toMatchObject({ state: 'duplicate', duplicateOf: older.id });
    expect(store.memories.get(older.id)).toMatchObject({ state: 'active', duplicateOf: null });
  });

  it('never lets an untrusted copy replace a trusted one, whichever is older', async () => {
    const { store, project, save, upkeep } = setup();
    const untrusted = save('run the seed script first', [], 'untrusted');
    const trusted = save('run the seed script first');
    expect(await upkeep()).toMatchObject({ duplicates: 0 });
    expect(store.memories.get(untrusted.id)?.state).toBe('active');
    expect(store.memories.get(trusted.id)?.state).toBe('active');
    expect(recalled(store, { trusted: true, project })).toHaveLength(2);
  });

  it('merges notes whose text differs only in Unicode form, case-sensitively', async () => {
    const { store, save, upkeep } = setup();
    const first = save('use the café fixture');
    const second = save('use  the café fixture ');
    const third = save('Use the café fixture');
    expect(await upkeep()).toMatchObject({ duplicates: 1 });
    expect(store.memories.get(second.id)).toMatchObject({ state: 'duplicate', duplicateOf: first.id });
    expect(store.memories.get(third.id)?.state).toBe('active');
  });

  it('leaves a note a newer note replaced as it is, since recall already skips it', async () => {
    const { store, clock, project, run, save, upkeep } = setup();
    const kept = save('kept note');
    const replaced = save('old wording');
    const replacement = store.memories.save({
      origin: 'trusted',
      scope: 'project',
      project,
      text: 'new wording',
      runId: run.id,
      step: 1,
      callId: 'c11',
      supersedes: [replaced.id],
    }).memory;
    clock.advance(FORGET_MS);
    store.memories.stampContributed([kept.id, replacement.id], clock.now());
    expect(await upkeep()).toMatchObject({ duplicates: 0, archived: 0 });
    expect(store.memories.get(replaced.id)?.state).toBe('active');
  });

  it('does not merge use X with do not use X', async () => {
    const { store, project, save, upkeep } = setup();
    const a = save('use X');
    const b = save('do not use X');
    expect(await upkeep()).toMatchObject({ duplicates: 0 });
    expect(recalled(store, { trusted: true, project }).map((memory) => memory.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('archives an idle unbound note and a stale one, and keeps a verified one of the same age', async () => {
    const { store, clock, project, save, upkeep, fileEvidence } = setup();
    const unbound = save('unbound note');
    const stale = save('stale note', fileEvidence('stale.txt', 'older content'));
    const verified = save('verified note', fileEvidence('verified.txt', 'current'));
    clock.advance(FORGET_MS);
    expect(await upkeep()).toMatchObject({ archived: 2 });
    expect(store.memories.get(unbound.id)?.state).toBe('archived');
    expect(store.memories.get(stale.id)?.state).toBe('archived');
    expect(store.memories.get(verified.id)?.state).toBe('active');
    expect(recalled(store, { trusted: true, project }).map((memory) => memory.id)).toEqual([verified.id]);
    expect(store.memories.search({ trusted: true, project }, ['unbound'], { include: 'all' }).map((memory) => memory.id)).toEqual([unbound.id]);
  });

  it('keeps a note that contributed inside the window', async () => {
    const { store, clock, save, upkeep } = setup();
    const note = save('used note');
    const other = save('idle note');
    clock.advance(FORGET_MS - 1);
    store.memories.stampContributed([note.id], clock.now());
    clock.advance(1);
    await upkeep();
    expect(store.memories.get(note.id)?.state).toBe('active');
    expect(store.memories.get(other.id)?.state).toBe('archived');
  });

  it('deletes nothing', async () => {
    const { store, clock, save, upkeep } = setup();
    save('same');
    save('same');
    save('idle');
    clock.advance(FORGET_MS);
    await upkeep();
    expect(store.memories.list()).toHaveLength(3);
  });

  it('does at most one bounded batch of marks per call and drains over calls', async () => {
    const { store, save, upkeep } = setup();
    for (const text of ['a1', 'a1', 'b2', 'b2', 'c3', 'c3']) save(text);
    const marked = () => store.memories.list().filter((memory) => memory.state === 'duplicate').length;
    await upkeep(2);
    expect(marked()).toBeGreaterThan(0);
    expect(marked()).toBeLessThanOrEqual(2);
    await upkeep(2);
    await upkeep(2);
    await upkeep(2);
    expect(marked()).toBe(3);
  });

  it('is not starved by old notes that stay active', async () => {
    const { store, clock, save, upkeep, fileEvidence } = setup();
    for (const name of ['v1', 'v2', 'v3']) save(name, fileEvidence(`${name}.txt`, 'current'));
    const idle = save('idle note');
    clock.advance(FORGET_MS);
    for (let turn = 0; turn < 6; turn += 1) await upkeep(2);
    expect(store.memories.get(idle.id)?.state).toBe('archived');
  });
});

describe('a pass over pages', () => {
  const pagesOf = async (env: ReturnType<typeof setup>, pageRows: number, forgetAfterDays: (project: string | null) => Promise<number> = async () => 90) => {
    const pass = beginUpkeepPass(env.store);
    const results: Awaited<ReturnType<typeof runMemoryUpkeep>>[] = [];
    do {
      results.push(await runMemoryUpkeep({ store: env.store, clock: env.clock, views: env.views, forgetAfterDays, batchSize: 100, signal: SIGNAL, pass, pageRows }));
    } while (!results.at(-1)?.done);
    return results;
  };

  it('finds a duplicate whose copies sit on different pages, because the pass remembers what it kept', async () => {
    const env = setup();
    const first = env.save('shared note');
    env.save('filler one');
    env.save('filler two');
    env.save('filler three');
    const copy = env.save('shared note');
    const results = await pagesOf(env, 2);
    expect(results.length).toBeGreaterThan(1);
    expect(env.store.memories.get(copy.id)).toMatchObject({ state: 'duplicate', duplicateOf: first.id });
    expect(results.reduce((sum, result) => sum + result.duplicates, 0)).toBe(1);
  });

  it('reads one page per call and ends when a page comes back short', async () => {
    const env = setup();
    for (const text of ['a', 'b', 'c', 'd', 'e']) env.save(text);
    const results = await pagesOf(env, 2);
    expect(results.map((result) => result.done)).toEqual([false, false, true]);
  });

  it('does not move past a page whose marks did not all fit, and finishes it on the next call', async () => {
    const env = setup();
    for (const text of ['x', 'x', 'y', 'y', 'z', 'z']) env.save(text);
    const pass = beginUpkeepPass(env.store);
    const call = () => runMemoryUpkeep({ store: env.store, clock: env.clock, views: env.views, forgetAfterDays: async () => 90, batchSize: 2, signal: SIGNAL, pass, pageRows: 10 });
    expect(await call()).toMatchObject({ duplicates: 2, done: false });
    expect(await call()).toMatchObject({ duplicates: 1, done: true });
    expect(env.store.memories.list().filter((memory) => memory.state === 'duplicate')).toHaveLength(3);
  });

  it('skips a project whose folder is gone with one recorded result, and leaves the other projects alone', async () => {
    const env = setup();
    const gone = fs.realpathSync.native(makeStoreDir());
    env.store.trust.set(gone, 'trusted');
    const orphan = env.saveAt(gone, 'orphan note');
    const kept = env.save('idle note');
    env.clock.advance(FORGET_MS);
    fs.rmSync(gone, { recursive: true, force: true });
    const asked: (string | null)[] = [];
    const results = await pagesOf(env, 1, async (project) => {
      asked.push(project);
      return 90;
    });
    expect(results.flatMap((result) => result.skipped)).toEqual([gone]);
    expect(asked).not.toContain(gone);
    expect(env.store.memories.get(orphan.id)?.state).toBe('active');
    expect(env.store.memories.get(kept.id)?.state).toBe('archived');
  });
});

describe('the upkeep schedule', () => {
  const schedule = (env: ReturnType<typeof setup>, passIntervalMs = 1000) => {
    const skipped: string[] = [];
    const created = createMemoryUpkeepSchedule({
      store: env.store,
      clock: env.clock,
      views: env.views,
      forgetAfterDays: async () => 90,
      batchSize: 100,
      pageRows: 100,
      passIntervalMs,
      onSkipped: (project: string) => skipped.push(project),
    });
    return { tick: () => created.tick(SIGNAL), skipped };
  };

  it('runs a pass at start, then waits for a memory write or the interval', async () => {
    const env = setup();
    env.save('a');
    const { tick } = schedule(env, 1000);
    expect(await tick()).toMatchObject({ done: true });
    expect(await tick()).toBeUndefined();
    env.clock.advance(999);
    expect(await tick()).toBeUndefined();
    env.clock.advance(1);
    expect(await tick()).toMatchObject({ done: true });
  });

  it('runs a pass after a memory write, and not again for its own marks', async () => {
    const env = setup();
    const { tick } = schedule(env, 1_000_000);
    await tick();
    expect(await tick()).toBeUndefined();
    env.save('same');
    env.save('same');
    expect(await tick()).toMatchObject({ duplicates: 1 });
    expect(await tick()).toBeUndefined();
  });

  it('finishes the pass it is in before it starts the next one', async () => {
    const env = setup();
    for (const text of ['a', 'b', 'c']) env.save(text);
    const created = createMemoryUpkeepSchedule({
      store: env.store,
      clock: env.clock,
      views: env.views,
      forgetAfterDays: async () => 90,
      batchSize: 100,
      pageRows: 2,
      passIntervalMs: 1_000_000,
      onSkipped: () => undefined,
    });
    expect(await created.tick(SIGNAL)).toMatchObject({ done: false });
    env.save('d');
    expect(await created.tick(SIGNAL)).toMatchObject({ done: false });
    expect(await created.tick(SIGNAL)).toMatchObject({ done: true });
    expect(await created.tick(SIGNAL)).toMatchObject({ done: false });
  });

  it('reports a vanished project once for the pass', async () => {
    const env = setup();
    const gone = fs.realpathSync.native(makeStoreDir());
    env.saveAt(gone, 'orphan note');
    fs.rmSync(gone, { recursive: true, force: true });
    const { tick, skipped } = schedule(env);
    await tick();
    expect(skipped).toEqual([gone]);
  });
});

describe('startMemorySweeper', () => {
  type Sweeper = { close(): Promise<void> };

  const start = (options: Record<string, unknown>): Sweeper => exported<(options: Record<string, unknown>) => Sweeper>('startMemorySweeper')(options);

  it('runs one upkeep and one reflection turn per interval, survives an error and stops on close', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const seen: string[] = [];
    const errors: unknown[] = [];
    const failure = new Error('upkeep failed');
    const sweeper = start({
      timers,
      intervalMs: 1000,
      upkeep: async () => {
        seen.push('upkeep');
        if (seen.length === 1) throw failure;
      },
      reflect: async () => {
        seen.push('reflect');
        return 'idle';
      },
      onError: (error: unknown) => errors.push(error),
    });
    timers.advance(1000);
    await afterMicrotasks();
    timers.advance(1000);
    await afterMicrotasks();
    expect(seen.filter((entry) => entry === 'upkeep')).toHaveLength(2);
    expect(seen.filter((entry) => entry === 'reflect')).toHaveLength(2);
    expect(errors).toEqual([failure]);
    await sweeper.close();
    timers.advance(5000);
    await afterMicrotasks();
    expect(seen.filter((entry) => entry === 'upkeep')).toHaveLength(2);
    expect(timers.pending()).toEqual([]);
  });

  it('aborts the call in flight on close, which resolves without waiting for the model and reports no error', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const errors: unknown[] = [];
    const signals: AbortSignal[] = [];
    const sweeper = start({
      timers,
      intervalMs: 1000,
      upkeep: async () => undefined,
      reflect: (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
      onError: (error: unknown) => errors.push(error),
    });
    timers.advance(1000);
    await afterMicrotasks();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    await sweeper.close();
    expect(signals[0]?.aborted).toBe(true);
    expect(errors).toEqual([]);
    expect(timers.pending()).toEqual([]);
  });

  it('starts no second turn while one is still running', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    let release: () => void = () => undefined;
    let started = 0;
    const sweeper = start({
      timers,
      intervalMs: 1000,
      upkeep: async () => {
        started += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      reflect: async () => 'idle',
      onError: () => undefined,
    });
    timers.advance(1000);
    await afterMicrotasks();
    timers.advance(5000);
    await afterMicrotasks();
    expect(started).toBe(1);
    release();
    await sweeper.close();
  });

  it('reports a failure of the reflection turn too, and goes on', async () => {
    const clock = createFakeClock(START_MS);
    const timers = createFakeTimers(clock);
    const errors: unknown[] = [];
    const failure = new Error('reflection failed');
    let turns = 0;
    const sweeper = start({
      timers,
      intervalMs: 1000,
      upkeep: async () => undefined,
      reflect: async () => {
        turns += 1;
        if (turns === 1) throw failure;
        return 'idle';
      },
      onError: (error: unknown) => errors.push(error),
    });
    timers.advance(1000);
    await afterMicrotasks();
    timers.advance(1000);
    await afterMicrotasks();
    expect(turns).toBe(2);
    expect(errors).toEqual([failure]);
    await sweeper.close();
  });
});

describe('wiring', () => {
  const sourcesUnder = (relative: string): string => {
    const directory = path.join(import.meta.dirname, '../../src', relative);
    return fs.readdirSync(directory).filter((name) => name.endsWith('.ts')).map((name) => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n');
  };

  it('starts the memory sweeper in the runtime', () => {
    expect(`${sourcesUnder('service')}${sourcesUnder('process')}`).toMatch(/startMemorySweeper\(/);
  });
});
