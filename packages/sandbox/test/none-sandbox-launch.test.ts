import { describe, expect, it } from 'vitest';
import { spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll } from 'vitest';
import { createPathResolver, momongaLayout, nodeFileSystem, protectedAreasOf } from '@momonga/foundation';
import { createTempDir } from '@momonga/testkit';
import { DEFAULT_BWRAP_PATH, DEFAULT_SANDBOX_EXEC_PATH, noneSandboxLaunchOf } from '../src/index.ts';

const HOME = fs.realpathSync(createTempDir());
const SAME_PATHS = createPathResolver(nodeFileSystem, new AbortController().signal);

afterAll(() => fs.rmSync(HOME, { recursive: true, force: true }));
const present = async (): Promise<boolean> => true;
const absent = async (): Promise<boolean> => false;

describe('the one launch of a child that runs outside the command sandbox', () => {
  it('denies the areas of the home on macOS and wraps the command in the seatbelt profile', async () => {
    const launch = await noneSandboxLaunchOf({ home: HOME, platform: 'darwin', env: {}, isUsableBinary: absent, paths: SAME_PATHS });
    expect(launch.protection).toEqual({ kind: 'home-denied', home: HOME, denied: protectedAreasOf(momongaLayout(HOME, 'darwin', {})) });
    const command = launch.commandOf(['git', 'ls-files'], []);
    expect(command.file).toBe(DEFAULT_SANDBOX_EXEC_PATH);
    expect(command.args.slice(-3)).toEqual(['--', 'git', 'ls-files']);
  });

  it('denies the home on Linux through bubblewrap when it is usable', async () => {
    const asked: string[] = [];
    const launch = await noneSandboxLaunchOf({ home: HOME, platform: 'linux', env: {}, isUsableBinary: async (file) => (asked.push(file), true), paths: SAME_PATHS });
    expect(asked).toEqual([DEFAULT_BWRAP_PATH]);
    expect(launch.protection.kind).toBe('home-denied');
    expect(launch.commandOf(['git'], []).file).toBe(DEFAULT_BWRAP_PATH);
  });

  it('says what is not protected on Linux without bubblewrap and where the platform has no sandbox', async () => {
    for (const launch of [
      await noneSandboxLaunchOf({ home: HOME, platform: 'linux', env: {}, isUsableBinary: absent, paths: SAME_PATHS }),
      await noneSandboxLaunchOf({ home: HOME, platform: 'win32', env: {}, isUsableBinary: present, paths: SAME_PATHS }),
    ]) {
      expect(launch.protection.kind).toBe('unprotected');
      expect(launch.commandOf(['git', 'ls-files'], [])).toEqual({ file: 'git', args: ['ls-files'] });
    }
  });
});

describe.runIf(process.platform === 'darwin')('a child under the real seatbelt protection on macOS', () => {
  it('creates a repository in a scratch folder that lies deep inside a denied area of the home', async () => {
    const launch = await noneSandboxLaunchOf({ home: HOME, platform: 'darwin', env: {}, isUsableBinary: absent, paths: SAME_PATHS });
    const store = path.join(momongaLayout(HOME, 'darwin', {}).root, 'state', 'observer', 'store');
    fs.mkdirSync(store, { recursive: true });
    const command = launch.commandOf(['git', 'init', '-q'], [store]);
    const ran = spawnSync(command.file, command.args, { cwd: HOME, env: { PATH: process.env['PATH'] ?? '', GIT_DIR: store, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8', input: '' });
    expect(ran.stderr).toBe('');
    expect(ran.status).toBe(0);
    expect(fs.existsSync(path.join(store, 'HEAD'))).toBe(true);
  });
});
