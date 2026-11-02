import { describe, expect, it } from 'vitest';
import { pathsOf } from '../src/paths.ts';

describe('pathsOf', () => {
  it('lays the paths out for the platform of the ports, not the platform of the process', () => {
    const home = '/tmp';

    const windows = pathsOf({ home, platform: 'win32' });
    const linux = pathsOf({ home, platform: 'linux' });

    expect(windows.sockets.supervisor).not.toBe(linux.sockets.supervisor);
  });
});
