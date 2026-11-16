import { afterEach, describe, expect, it } from 'vitest';
import { APPLE_PROGRAMS, fakePolicyFilesystem } from '@momonga/testkit';

const GNU_PROGRAMS: Readonly<Record<string, string>> = { ls: '/usr/bin/ls', grep: '/usr/bin/grep', sed: '/usr/bin/sed' };

const hostPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

const pretendHost = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

describe('the platform of the policy fixture is the one it names, never the host', () => {
  afterEach(() => {
    if (hostPlatform !== undefined) Object.defineProperty(process, 'platform', hostPlatform);
  });

  it('on a Linux host the fake still reports darwin unless the row names a platform', () => {
    pretendHost('linux');
    expect(fakePolicyFilesystem().platform).toBe('darwin');
    expect(fakePolicyFilesystem({ programs: APPLE_PROGRAMS }).platform).toBe('darwin');
  });

  it('a GNU program table with no platform does not change the platform: it stays darwin', () => {
    pretendHost('linux');
    expect(fakePolicyFilesystem({ programs: GNU_PROGRAMS }).platform).toBe('darwin');
  });

  it('a row that names linux gets linux, on any host', () => {
    pretendHost('darwin');
    expect(fakePolicyFilesystem({ platform: 'linux', programs: GNU_PROGRAMS }).platform).toBe('linux');
  });
});
