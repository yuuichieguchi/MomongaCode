import { describe, expect, it } from 'vitest';
import { ORPHAN_REAP_GRACE_MS, RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS, STARTUP_TIMEOUT_MS, runtimeMaxCloseMs } from '@momonga/foundation';
import { daemonReadyBoundMs } from '../src/daemon/ensure-daemon.ts';

describe('the daemon ready bound covers the predecessor runtime close (design rev 7, R9)', () => {
  it('is at least runtimeMaxCloseMs(default drain) + the orphan reap grace + the start-up timeout', async () => {
    const required = runtimeMaxCloseMs(RUNTIME_DEFAULT_DRAIN_TIMEOUT_MS) + ORPHAN_REAP_GRACE_MS + STARTUP_TIMEOUT_MS;
    expect(required).toBe(120_000);
    expect(await daemonReadyBoundMs()).toBeGreaterThanOrEqual(required);
  });
});
