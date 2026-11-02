import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireProcessLock } from '@momonga/foundation';
import { createFakeKernelLock, withTempDir } from '@momonga/testkit';

describe('a process lock whose holder cannot be recorded', () => {
  it('is released, so a later claim does not time out naming this process', async (context) => {
    const lockPath = path.join(withTempDir(context), 'missing', 'a.lock');
    const fake = createFakeKernelLock({ inheritable: false });

    await expect(acquireProcessLock(lockPath, undefined, { mechanism: fake })).rejects.toMatchObject({ code: 'ENOENT' });

    expect(fake.isHeldBy(lockPath)).toBeUndefined();
  });
});
