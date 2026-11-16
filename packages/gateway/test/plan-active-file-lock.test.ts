import { afterEach, describe, expect, it } from 'vitest';
import { claimPathOf } from '@momonga/foundation';
import type { KernelLockMechanism } from '@momonga/foundation';
import { testKernelLock } from '@momonga/testkit';
import { PROFILE_ID, signedIn, startHarness } from './plan-support.ts';
import type { Harness } from './plan-support.ts';

const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const work = { profile: PROFILE_ID, account: 'work' };
const home = { profile: PROFILE_ID, account: 'home' };

const signal = (): AbortSignal => new AbortController().signal;

const recordingLock = (base: KernelLockMechanism, claimed: string[]): KernelLockMechanism => ({
  ...base,
  claim: (lockPath) => {
    claimed.push(lockPath);
    return base.claim(lockPath);
  },
});

describe('the active account file is moved under its file lock', () => {
  it('claims the lock of the active account file for the read and the write of a move', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await signedIn(h, 'work');
    h.auth.identity = { sub: 'sub-second-user', email: 'second@example.com' };
    await signedIn(h, 'home');
    const base = testKernelLock();
    const claimed: string[] = [];
    await h.reopen({ accounts: [work, home], lock: recordingLock(base, claimed) });
    claimed.length = 0;

    await h.sessions.selectActive(work, signal());

    expect(claimed).toContain(claimPathOf(base, h.paths.active, 'sidecar'));
  });
});
