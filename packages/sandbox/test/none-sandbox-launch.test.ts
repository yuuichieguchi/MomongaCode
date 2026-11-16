import { describe, expect, it } from 'vitest';
import { momongaLayout, protectedAreasOf } from '@momonga/foundation';
import { DEFAULT_BWRAP_PATH, DEFAULT_SANDBOX_EXEC_PATH, noneSandboxLaunchOf } from '../src/index.ts';

const HOME = '/home/person';
const present = async (): Promise<boolean> => true;
const absent = async (): Promise<boolean> => false;

describe('the one launch of a child that runs outside the command sandbox', () => {
  it('denies the areas of the home on macOS and wraps the command in the seatbelt profile', async () => {
    const launch = await noneSandboxLaunchOf({ home: HOME, platform: 'darwin', env: {}, isUsableBinary: absent });
    expect(launch.protection).toEqual({ kind: 'home-denied', home: HOME, denied: protectedAreasOf(momongaLayout(HOME, 'darwin', {})) });
    const command = launch.commandOf(['git', 'ls-files'], []);
    expect(command.file).toBe(DEFAULT_SANDBOX_EXEC_PATH);
    expect(command.args.slice(-3)).toEqual(['--', 'git', 'ls-files']);
  });

  it('denies the home on Linux through bubblewrap when it is usable', async () => {
    const asked: string[] = [];
    const launch = await noneSandboxLaunchOf({ home: HOME, platform: 'linux', env: {}, isUsableBinary: async (file) => (asked.push(file), true) });
    expect(asked).toEqual([DEFAULT_BWRAP_PATH]);
    expect(launch.protection.kind).toBe('home-denied');
    expect(launch.commandOf(['git'], []).file).toBe(DEFAULT_BWRAP_PATH);
  });

  it('says what is not protected on Linux without bubblewrap and where the platform has no sandbox', async () => {
    for (const launch of [
      await noneSandboxLaunchOf({ home: HOME, platform: 'linux', env: {}, isUsableBinary: absent }),
      await noneSandboxLaunchOf({ home: HOME, platform: 'win32', env: {}, isUsableBinary: present }),
    ]) {
      expect(launch.protection.kind).toBe('unprotected');
      expect(launch.commandOf(['git', 'ls-files'], [])).toEqual({ file: 'git', args: ['ls-files'] });
    }
  });
});
