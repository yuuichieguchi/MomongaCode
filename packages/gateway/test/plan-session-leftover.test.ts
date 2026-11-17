import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HeldKernelLock, KernelLockMechanism } from '@momonga/foundation';
import { startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';
import { expectedKernelLockOn, testKernelLock } from '@momonga/testkit';

const REFUSED_CODE_OF: Record<KernelLockMechanism['name'], string> = { 'file-lock': 'EACCES', 'sqlite-lock': 'ERR_SQLITE_ERROR' };

const harnesses: Harness[] = [];
const held: HeldKernelLock[] = [];

afterEach(async () => {
  for (const lock of held.splice(0)) lock.release();
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const makeLeftover = async (lock: KernelLockMechanism, entry: string): Promise<void> => {
  const outcome = await lock.claim(entry);
  if (outcome.kind !== 'claimed') throw new Error(`${entry} could not be claimed by the test`);
  fs.writeFileSync(entry, 'left by a crash', { mode: 0o600 });
  outcome.lock.release();
};

const holdEntry = async (entry: string): Promise<void> => {
  const outcome = await testKernelLock().claim(entry);
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

  for (const platform of ['darwin', 'linux'] as const) {
    it(`${platform} mechanism: removes a temporary whose lock no one holds, with its sidecar, at the same start`, async () => {
      const lock = expectedKernelLockOn(platform);
      const h = await startHarness();
      harnesses.push(h);
      fs.mkdirSync(h.paths.sessions, { recursive: true });
      const abandoned = path.join(h.paths.sessions, '.work.json.0a1b2c3d4e5f.tmp');
      await makeLeftover(lock, abandoned);
      await h.reopen({ lock });
      expect(fs.readdirSync(h.paths.sessions).filter((name) => name.startsWith('.work.json.'))).toEqual([]);
    });
  }
});

describe('S7: a host condition on one leftover never stops the gateway start', () => {
  it('keeps a temporary it cannot remove, warns once with its path and code, and still opens', async () => {
    const h = await startHarness();
    harnesses.push(h);
    fs.mkdirSync(h.paths.sessions, { recursive: true });
    const stuck = path.join(h.paths.sessions, '.work.json.0a1b2c3d4e5f.tmp');
    const lock = testKernelLock();
    await makeLeftover(lock, stuck);
    const warningsBefore = h.warnings.length;
    fs.chmodSync(h.paths.sessions, 0o500);
    try {
      await expect(h.reopen({ lock })).resolves.toBeDefined();
    } finally {
      fs.chmodSync(h.paths.sessions, 0o700);
    }
    expect(fs.existsSync(stuck)).toBe(true);
    expect(h.warnings.slice(warningsBefore).filter((message) => message.includes(stuck))).toEqual([`leftover cleanup kept ${stuck}: ${REFUSED_CODE_OF[lock.name]}`]);
  });
});
