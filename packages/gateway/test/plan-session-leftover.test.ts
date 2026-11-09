import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hostKernelLock } from '@momonga/foundation';
import type { HeldKernelLock } from '@momonga/foundation';
import { startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];
const held: HeldKernelLock[] = [];

afterEach(async () => {
  for (const lock of held.splice(0)) lock.release();
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const holdEntry = async (entry: string): Promise<void> => {
  const outcome = await hostKernelLock().claim(entry);
  if (outcome.kind !== 'claimed') throw new Error(`${entry} could not be claimed by the test`);
  held.push(outcome.lock);
  if (!fs.existsSync(entry)) fs.writeFileSync(entry, 'in flight', { mode: 0o600 });
};

describe('session.ts:229-237: the gateway start never removes a temporary whose writer holds its lock', () => {
  it('keeps a held temporary in the plan sessions directory when a second gateway opens it (the noTempLock variant)', async () => {
    const h = await startHarness();
    harnesses.push(h);
    fs.mkdirSync(h.paths.sessions, { recursive: true });
    const inFlight = path.join(h.paths.sessions, '.work.json.0a1b2c3d4e5f.tmp');
    await holdEntry(inFlight);
    await h.reopen();
    expect(fs.existsSync(inFlight)).toBe(true);
  });

  it('removes a temporary whose lock no one holds, at the same start', async () => {
    const h = await startHarness();
    harnesses.push(h);
    fs.mkdirSync(h.paths.sessions, { recursive: true });
    const abandoned = path.join(h.paths.sessions, '.work.json.0a1b2c3d4e5f.tmp');
    fs.writeFileSync(abandoned, 'left by a crash', { mode: 0o600 });
    await h.reopen();
    expect(fs.existsSync(abandoned)).toBe(false);
  });
});
