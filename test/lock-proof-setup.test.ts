import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCK_PROOF_ENV, productTestEnv, testKernelLock } from '@momonga/testkit';
import setup from './support/lock-proof.ts';

describe('the lock proof folder of a test run', () => {
  it('is made by the run setup and gone when its teardown ends, before the leak guard looks', () => {
    const outer = process.env[LOCK_PROOF_ENV];
    try {
      const teardown = setup();
      const made = process.env[LOCK_PROOF_ENV];
      if (made === undefined) throw new Error('the setup named no lock proof folder');
      expect(fs.statSync(made).isDirectory()).toBe(true);
      teardown();
      expect(fs.existsSync(made)).toBe(false);
    } finally {
      process.env[LOCK_PROOF_ENV] = outer;
    }
  });

  it('holds the proof of each test process in that folder', () => {
    testKernelLock();
    const folder = process.env[LOCK_PROOF_ENV];
    if (folder === undefined) throw new Error('the run has no lock proof folder');
    expect(fs.readdirSync(folder)).toContain(String(process.pid));
    expect(fs.statSync(path.join(folder, String(process.pid))).isDirectory()).toBe(true);
  });

  it('is carried to every product process a test starts, by the one environment of those processes', () => {
    expect(productTestEnv({ HOME: '/nowhere' })[LOCK_PROOF_ENV]).toBe(process.env[LOCK_PROOF_ENV]);
  });
});
