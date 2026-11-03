import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureMomongaDirs } from '@momonga/foundation';
import { openRuntimeStore } from '@momonga/store';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, afterMicrotasks, createFakeClock, createFakeTimers, waitFor } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';
import { START_MS } from './helpers.ts';
import {
  FIVE_MINUTES_MS,
  HOUR_MS,
  STORE_IDENTITY_CHECK_MS,
  entriesNamed,
  eventTypes,
  finishApprovingPrompts,
  launchRuntime,
  readDb,
  scriptedToolCall,
  startStack,
} from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
const DAY_MS = 86_400_000;
const SESSION_STATE_IDLE_MS = 1_800_000;
const EXPIRED_KEY = 'a'.repeat(64);
const LIVE_KEY = 'b'.repeat(64);

const fakeTime = () => {
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  return { clock, timers };
};

const advanceStepwise = async (timers: FakeTimers, totalMs: number, stepMs: number): Promise<void> => {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    timers.advance(Math.min(stepMs, totalMs - elapsed));
    await afterMicrotasks();
  }
};

const seedIdempotency = async (temp: RunHome): Promise<void> => {
  await ensureMomongaDirs(temp.paths);
  const store = openRuntimeStore({
    path: temp.paths.databases.runtime,
    home: temp.home,
    clock: createFakeClock(START_MS - 8 * DAY_MS),
    leaseMs: 30_000,
    maxAttempts: 5,
    maxTotalAttempts: 20,
  });
  try {
    store.idempotency.begin(EXPIRED_KEY, { expiresAt: START_MS - 1, meta: {} });
    store.idempotency.begin(LIVE_KEY, { expiresAt: START_MS + 2 * HOUR_MS, meta: {} });
  } finally {
    store.close();
  }
};

const idempotencyKeys = (temp: RunHome): string[] =>
  readDb<{ key: string }>(temp.paths.databases.runtime, 'SELECT key FROM idempotency ORDER BY key').map((row) => row.key);

const delays = (timers: FakeTimers): number[] => timers.pending().map((timer) => timer.delayMs);

describe('runtime periodic timers (fake timers and fake clock, in-process gateway)', () => {
  it('the purge runs hourly and removes an expired idempotency record', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    await seedIdempotency(stack.temp);
    const { clock, timers } = fakeTime();
    await launchRuntime(stack.temp, { clock, fakeTimers: timers });
    expect(idempotencyKeys(stack.temp)).toEqual([EXPIRED_KEY, LIVE_KEY]);
    timers.advance(HOUR_MS - 1);
    await afterMicrotasks();
    expect(idempotencyKeys(stack.temp)).toEqual([EXPIRED_KEY, LIVE_KEY]);
    timers.advance(1);
    await afterMicrotasks();
    expect(idempotencyKeys(stack.temp)).toEqual([LIVE_KEY]);
  });

  it('the session tmp sweep runs hourly with the session-state registry', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const { clock, timers } = fakeTime();
    const launched = await launchRuntime(stack.temp, { clock, fakeTimers: timers });
    const known = await launched.createSession();
    const knownDir = path.join(stack.temp.paths.tmp.sessions, known.id);
    const unknownDir = path.join(stack.temp.paths.tmp.sessions, 'unknown-session');
    fs.mkdirSync(knownDir, { recursive: true });
    fs.mkdirSync(unknownDir, { recursive: true });
    timers.advance(HOUR_MS - 1);
    await afterMicrotasks();
    expect(fs.existsSync(unknownDir)).toBe(true);
    timers.advance(1);
    await waitFor(() => fs.readdirSync(stack.temp.paths.tmp.sessions).join(',') === known.id, {
      description: 'the hourly sweep to remove the unknown session dir and its renamed copy',
    });
    expect(fs.existsSync(knownDir)).toBe(true);
  });

  it('the ledger sweep runs every 5 minutes and evicts an idle session state', PROCESS_TIMEOUT, async () => {
    const stack = await startStack((temp) => ({ script: [scriptedToolCall('Read', { file_path: path.join(temp.project, 'notes.txt') })] }));
    fs.writeFileSync(path.join(stack.temp.project, 'notes.txt'), 'remember this\n');
    const { clock, timers } = fakeTime();
    const launched = await launchRuntime(stack.temp, { clock, fakeTimers: timers });
    const session = await launched.createSession();
    const run = await launched.createRun(session.id, { input: 'Use the Read tool' });
    expect(await finishApprovingPrompts(launched, stack.temp, run.id)).toBe('COMPLETED');
    expect(eventTypes(stack.temp, run.id)).toContain('tool.started');
    expect(delays(timers)).toContain(FIVE_MINUTES_MS);
    await advanceStepwise(timers, SESSION_STATE_IDLE_MS - FIVE_MINUTES_MS, FIVE_MINUTES_MS);
    expect(entriesNamed(launched.logger, 'session_state.evicted')).toEqual([]);
    await advanceStepwise(timers, FIVE_MINUTES_MS, FIVE_MINUTES_MS);
    const evicted = entriesNamed(launched.logger, 'session_state.evicted');
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.fields).toMatchObject({ count: 1, ids: [session.id] });
  });

  it('all four timers are stopped by close and abort: fakeTimers.pending() has none of them', PROCESS_TIMEOUT, async () => {
    const stack = await startStack();
    const first = fakeTime();
    const closing = await launchRuntime(stack.temp, { clock: first.clock, fakeTimers: first.timers });
    expect(delays(first.timers).filter((delay) => delay === HOUR_MS).length).toBeGreaterThanOrEqual(2);
    expect(delays(first.timers)).toContain(FIVE_MINUTES_MS);
    expect(delays(first.timers)).toContain(STORE_IDENTITY_CHECK_MS);
    expect(await closing.handle.close()).toEqual({ clean: true, abandoned: [], stragglers: [] });
    expect(first.timers.pending()).toEqual([]);

    const second = fakeTime();
    const aborting = await launchRuntime(stack.temp, { clock: second.clock, fakeTimers: second.timers });
    expect(delays(second.timers)).toContain(STORE_IDENTITY_CHECK_MS);
    expect(await aborting.handle.abort()).toEqual({ clean: true, abandoned: [], stragglers: [] });
    expect(second.timers.pending()).toEqual([]);
  });
});
