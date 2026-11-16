import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { formatStartRecord, momongaPaths } from '@momonga/foundation';
import type { GenerationRole, RolePort } from '@momonga/foundation';
import { FIDELITY_FOLD_VERSION } from '@momonga/protocol';
import { createFakeClock, createFakeTimers, prepareGenerationForTest, testKernelLock } from '@momonga/testkit';
import type { FakeTimers } from '@momonga/testkit';
import { IDEMPOTENCY_PURGE_MS } from '../../src/process/constants.ts';
import { RUNTIME_VERSION, SERVING_TICK_MS, launchRuntime, startStack, waitForCondition } from '../process/run-helpers.ts';
import type { RunHome } from '../process/run-helpers.ts';

const START_MS = 1_800_000_000_000;
const PRUNE_INTERVAL_MS = 3_600_000;
const OTHER_GENERATION = 7;
const BELOW = FIDELITY_FOLD_VERSION - 1;
const ROWS = [BELOW, FIDELITY_FOLD_VERSION, FIDELITY_FOLD_VERSION + 1];

const switchableRole = (initial: GenerationRole): RolePort & { set(role: GenerationRole): void } => {
  let role = initial;
  return { current: () => role, refresh: async () => role, set: (next) => (role = next) };
};

const databaseOf = (temp: RunHome): string => momongaPaths(temp.home, process.platform, {}).databases.runtime;

const insertVerdict = (database: string, foldVersion: number, token: string): void => {
  const db = new DatabaseSync(database);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO fidelity_verdicts (run_id, cwd, fold_version, token, inh, inh_deps, task_stated, stated_at, executed_at, own_deps, checked_through)
       VALUES ('run-of-the-test', '/work/a', ?, ?, 'none', '[]', 0, NULL, NULL, '[]', 0)`,
    ).run(foldVersion, token);
  } finally {
    db.close();
  }
};

const foldVersions = (database: string): number[] => {
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    return db
      .prepare('SELECT fold_version FROM fidelity_verdicts ORDER BY fold_version, token')
      .all()
      .map((row) => Number(row['fold_version']));
  } finally {
    db.close();
  }
};

const ticks = async (timers: FakeTimers, count: number): Promise<void> => {
  for (let tick = 0; tick < count; tick += 1) {
    await timers.advanceAsync(SERVING_TICK_MS);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

const runtimeWith = async (role: RolePort) => {
  const stack = await startStack();
  const clock = createFakeClock(START_MS);
  const timers = createFakeTimers(clock);
  const launched = await launchRuntime(stack.temp, { clock, fakeTimers: timers, role });
  return { temp: stack.temp, timers, launched, database: databaseOf(stack.temp) };
};

describe('T-I4-28 (17.5, PruneBelowLive): the fidelity prune of a runtime process runs only while it serves', () => {
  it('prunes the rows below the fold version once the role becomes serving, again every 3 600 000 ms, and never while starting or retiring', async () => {
    expect(IDEMPOTENCY_PURGE_MS).toBe(PRUNE_INTERVAL_MS);
    const role = switchableRole('starting');
    const { timers, database } = await runtimeWith(role);
    ROWS.forEach((version, index) => insertVerdict(database, version, `first-${index}`));
    await ticks(timers, 3);
    expect(foldVersions(database)).toEqual(ROWS);

    role.set('serving');
    await ticks(timers, 1);
    await waitForCondition(() => !foldVersions(database).includes(BELOW), 'the prune at promotion');
    expect(foldVersions(database)).toEqual([FIDELITY_FOLD_VERSION, FIDELITY_FOLD_VERSION + 1]);

    insertVerdict(database, BELOW, 'second');
    await ticks(timers, 3);
    expect(foldVersions(database)).toContain(BELOW);
    await timers.advanceAsync(PRUNE_INTERVAL_MS);
    await ticks(timers, 1);
    await waitForCondition(() => !foldVersions(database).includes(BELOW), 'the prune one interval later');

    role.set('retiring');
    await ticks(timers, 1);
    insertVerdict(database, BELOW, 'third');
    await timers.advanceAsync(PRUNE_INTERVAL_MS);
    await ticks(timers, 3);
    expect(foldVersions(database)).toContain(BELOW);
  });

  it('bounds the prune by the lowest fold version among the live generations', async () => {
    const role = switchableRole('starting');
    const { temp, timers, database } = await runtimeWith(role);
    const other = prepareGenerationForTest(temp.home, OTHER_GENERATION, RUNTIME_VERSION);
    fs.writeFileSync(other.startRecord, formatStartRecord({ version: RUNTIME_VERSION, foldVersion: BELOW }));
    const held = await testKernelLock().claim(other.locks.supervisor);
    if (held.kind !== 'claimed') throw new Error('the test could not hold the supervisor lock of the other generation');
    try {
      ROWS.forEach((version, index) => insertVerdict(database, version, `row-${index}`));
      insertVerdict(database, BELOW - 1, 'oldest');
      role.set('serving');
      await ticks(timers, 1);
      await waitForCondition(() => !foldVersions(database).includes(BELOW - 1), 'the prune below the live minimum');
      expect(foldVersions(database)).toEqual(ROWS);
    } finally {
      held.lock.release();
    }
  });
});
