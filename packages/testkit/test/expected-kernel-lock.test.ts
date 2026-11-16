import { describe, expect, it } from 'vitest';
import { expectedKernelLockOn, testKernelLock } from '@momonga/testkit';

describe('the lock mechanism a test expects on a platform', () => {
  it.each(['darwin', 'linux'] as const)('on %s is the mechanism this host proves, not a mechanism named by the platform', (platform) => {
    expect(expectedKernelLockOn(platform).name).toBe(testKernelLock().name);
  });
});
