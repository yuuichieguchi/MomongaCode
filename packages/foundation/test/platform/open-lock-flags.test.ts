import { describe, expect, it } from 'vitest';
import { createLockCapability } from '../../src/platform/lock-capability.ts';
import { openLockFlagsOn } from '../../src/platform/open-lock-flags.ts';
import { makeTemporaryDirectory } from '../support/temporary-directory.ts';

describe('the open flags of the file lock are defined by the platform that defines them', () => {
  it('darwin defines the shared and the exclusive lock flags with the values of its sys/fcntl.h', () => {
    expect(openLockFlagsOn('darwin')).toEqual({ shared: 0x10, exclusive: 0x20 });
  });

  it.for(['linux', 'win32'])('%s defines no such flags, so no number is carried to it', (platform) => {
    expect(openLockFlagsOn(platform)).toBeUndefined();
  });

  it('a capability on a host without the flags never reads the directory as proved', async () => {
    const proofDir = makeTemporaryDirectory();
    const capability = createLockCapability({ proofDir, platform: 'linux' });
    expect(await capability.of(proofDir)).toBe('unenforced');
    expect(capability.decide(proofDir)).toBe('unenforced');
  });
});
