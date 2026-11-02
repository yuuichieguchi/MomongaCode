import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@momonga/foundation';
import type { MemoryEvidence } from '@momonga/protocol';
import { afterMicrotasks, createFakeClock, createFakeTimers } from '@momonga/testkit';
import { START_MS, callEvent, enqueue, harness, makeStoreDir, mustClaim, newSession } from '../../../store/test/helpers.ts';
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
  const save = (text: string, evidence: MemoryEvidence[] = []) => {
    const callId = free.shift();
    if (callId === undefined) throw new Error('out of calls');
    clock.advance(1);
    return store.memories.save({ origin: 'trusted', scope: 'project', project, text, runId: run.id, step: 1, callId, evidence }).memory;
  };
  const views = createRecordViews({ store, evidenceRun: () => async () => ({ exitCode: null }) });
  const upkeep = (batchSize = 100): Promise<{ duplicates: number; archived: number }> =>
    exported<(options: unknown) => Promise<{ duplicates: number; archived: number }>>('runMemoryUpkeep')({ store, clock, views, forgetAfterDays: async () => 90, batchSize, signal: SIGNAL });
  const fileEvidence = (name: string, recordedText: string): MemoryEvidence[] => {
    fs.writeFileSync(path.join(project, name), 'current');
    return [{ kind: 'file', project, path: name, sha256: sha256Hex(recordedText) }];
  };
  return { store, clock, project, save, upkeep, fileEvidence };
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

  it('does not merge use X with do not use X', async () => {
    const { store, project, save, upkeep } = setup();
    const a = save('use X');
    const b = save('do not use X');
    expect(await upkeep()).toMatchObject({ duplicates: 0 });
    expect(store.memories.recall({ trusted: true, project }).map((memory) => memory.id).sort()).toEqual([a.id, b.id].sort());
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
    expect(store.memories.recall({ trusted: true, project }).map((memory) => memory.id)).toEqual([verified.id]);
    expect(store.memories.search({ trusted: true, project }, ['unbound'], { include: 'all' }).map((memory) => memory.id)).toEqual([unbound.id]);
  });

  it('keeps a note that was used inside the window', async () => {
    const { store, clock, save, upkeep } = setup();
    const note = save('used note');
    const other = save('idle note');
    clock.advance(FORGET_MS - 1);
    store.memories.markUsed([note.id]);
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
});

describe('wiring', () => {
  const sourcesUnder = (relative: string): string => {
    const directory = path.join(import.meta.dirname, '../../src', relative);
    return fs.readdirSync(directory).filter((name) => name.endsWith('.ts')).map((name) => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n');
  };

  it('starts the memory sweeper in the runtime', () => {
    expect(`${sourcesUnder('service')}${sourcesUnder('process')}`).toMatch(/startMemorySweeper\(/);
  });

  it('enqueues a reflection when a run ends', () => {
    expect(`${sourcesUnder('worker')}${sourcesUnder('service')}${sourcesUnder('process')}`).toMatch(/enqueueReflection\(/);
  });
});
