import { describe, expect, it } from 'vitest';
import { directoryGone } from '../../src/daemon/ensure-daemon.ts';

const missing = (): Error => Object.assign(new Error('no such file'), { code: 'ENOENT' });

describe('the daemon start reads the generation directory through its files port', () => {
  it('a directory the files port cannot find is gone', async () => {
    const asked: string[] = [];
    const files = {
      lstat: async (directory: string): Promise<unknown> => {
        asked.push(directory);
        throw missing();
      },
    };
    expect(await directoryGone(files as never, '/home/person/.momonga/generations/7')).toBe(true);
    expect(asked).toEqual(['/home/person/.momonga/generations/7']);
  });

  it('a directory the files port finds is not gone', async () => {
    const files = { lstat: async (): Promise<unknown> => ({ isDirectory: () => true }) };
    expect(await directoryGone(files as never, '/home/person/.momonga/generations/7')).toBe(false);
  });

  it('a failure other than a missing file is raised, not read as gone', async () => {
    const files = { lstat: async (): Promise<unknown> => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) };
    await expect(directoryGone(files as never, '/x')).rejects.toThrow('denied');
  });
});
