import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { momongaLayout, nodeFileSystem, protectedAreasOf } from '@momonga/foundation';
import { DEFAULT_SANDBOX_EXEC_PATH } from '@momonga/sandbox';
import { createTempDir } from '@momonga/testkit';
import { homeProtectedLaunch } from '@momonga/runtime';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const linkedHome = (): { real: string; linked: string } => {
  const root = createTempDir();
  roots.push(root);
  const real = path.join(root, 'real-home');
  fs.mkdirSync(real);
  const linked = path.join(root, 'linked-home');
  fs.symlinkSync(real, linked);
  return { real, linked };
};

describe('the launch that denies the home to a process started outside the command sandbox', () => {
  it.runIf(process.platform === 'darwin')('denies the areas of the canonical home on macOS and wraps the command in the seatbelt profile', async () => {
    const { real, linked } = linkedHome();
    const launch = await homeProtectedLaunch({ home: linked, platform: 'darwin', env: {}, files: nodeFileSystem }, new AbortController().signal);
    expect(launch.protection).toEqual({ kind: 'home-denied', home: real, denied: protectedAreasOf(momongaLayout(real, 'darwin', {})) });
    const command = launch.commandOf(['git', 'ls-files'], []);
    expect(command.file).toBe(DEFAULT_SANDBOX_EXEC_PATH);
    expect(command.args.slice(-3)).toEqual(['--', 'git', 'ls-files']);
  });

  it('says what is not protected where the platform has no sandbox', async () => {
    const { real } = linkedHome();
    const launch = await homeProtectedLaunch({ home: real, platform: 'win32', env: {}, files: nodeFileSystem }, new AbortController().signal);
    expect(launch.protection.kind).toBe('unprotected');
    expect(launch.commandOf(['git', 'ls-files'], [])).toEqual({ file: 'git', args: ['ls-files'] });
  });
});
