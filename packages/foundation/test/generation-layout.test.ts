import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout } from '@momonga/foundation';

describe('the unscoped files of the run directory', () => {
  it('names run/current and run/generation.lock directly under run', () => {
    const layout = momongaLayout('/Users/alice', 'darwin', {});
    expect(layout).toMatchObject({ current: '/Users/alice/.momonga/run/current', generationLock: '/Users/alice/.momonga/run/generation.lock' });
  });

  it('names them on win32 under the same run directory', () => {
    const layout = momongaLayout('C:\\Users\\alice', 'win32', {});
    expect(layout).toMatchObject({
      current: path.win32.join('C:\\Users\\alice', '.momonga', 'run', 'current'),
      generationLock: path.win32.join('C:\\Users\\alice', '.momonga', 'run', 'generation.lock'),
    });
  });

  it('keeps no per-daemon socket or lock in the home-wide layout', () => {
    const layout = momongaLayout('/Users/alice', 'darwin', {});
    expect(layout).not.toHaveProperty('sockets');
    expect(layout).not.toHaveProperty('locks');
  });
});
