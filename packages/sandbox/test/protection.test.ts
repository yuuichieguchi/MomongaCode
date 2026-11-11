import { describe, expect, expectTypeOf, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalHomeOf, launchGroupLeader, momongaLayout, protectedAreasOf } from '@momonga/foundation';
import { testPaths } from '@momonga/testkit';
import type { ChildProtection, LaunchProtection } from '@momonga/foundation';

type GroupLaunchRequest = Parameters<typeof launchGroupLeader>[0];
import { buildProtectionProfile, childProtectionFor, planProtection, protectionCommandOf } from '@momonga/sandbox';

const HOME = '/home/someone';

describe('childProtectionFor', () => {
  it('denies the home of every child on macOS, under every sandbox setting', () => {
    for (const sandbox of ['none', 'seatbelt'] as const) {
      const protection = childProtectionFor({ sandbox, home: HOME, platform: 'darwin', env: {}, bubblewrap: false });
      expect(protection).toEqual({ kind: 'home-denied', home: HOME, denied: protectedAreasOf(momongaLayout(HOME, 'darwin', {})) });
    }
  });

  it('denies the home on Linux with bubblewrap present, also with sandbox none', () => {
    expect(childProtectionFor({ sandbox: 'none', home: HOME, platform: 'linux', env: {}, bubblewrap: true }).kind).toBe('home-denied');
    expect(childProtectionFor({ sandbox: 'bubblewrap', home: HOME, platform: 'linux', env: {}, bubblewrap: true }).kind).toBe('home-denied');
  });

  it('starts sandbox none children unprotected on Linux without bubblewrap, and says what is not protected and how to get it', () => {
    const protection = childProtectionFor({ sandbox: 'none', home: HOME, platform: 'linux', env: {}, bubblewrap: false });
    expect(protection.kind).toBe('unprotected');
    if (protection.kind !== 'unprotected') return;
    expect(protection.reason).toContain(momongaLayout(HOME, 'linux', {}).root);
    expect(protection.reason).toContain('install bubblewrap');
  });

  it('reports Windows children unprotected, naming the home', () => {
    const protection = childProtectionFor({ sandbox: 'none', home: 'C:\\Users\\someone', platform: 'win32', env: {}, bubblewrap: false });
    expect(protection.kind).toBe('unprotected');
    if (protection.kind !== 'unprotected') return;
    expect(protection.reason).toContain(momongaLayout('C:\\Users\\someone', 'win32', {}).root);
  });

  it('protects the set the layout places with the real environment, with XDG_CACHE_HOME set and unset', () => {
    for (const env of [{}, { XDG_CACHE_HOME: '/elsewhere/cache' }]) {
      const protection = childProtectionFor({ sandbox: 'none', home: HOME, platform: 'linux', env, bubblewrap: true });
      const layout = momongaLayout(HOME, 'linux', env);
      expect(protection).toEqual({ kind: 'home-denied', home: HOME, denied: protectedAreasOf(layout) });
      expect(protection.kind === 'home-denied' && protection.denied).toEqual(expect.arrayContaining([layout.root, layout.tmp.root, layout.executables]));
    }
    const moved = childProtectionFor({ sandbox: 'none', home: HOME, platform: 'linux', env: { XDG_CACHE_HOME: '/elsewhere/cache' }, bubblewrap: true });
    expect(moved.kind === 'home-denied' && moved.denied).toEqual(expect.arrayContaining(['/elsewhere/cache/momonga/tmp']));
  });
});

describe('the protection command', () => {
  const protection: ChildProtection = { kind: 'home-denied', home: HOME, denied: ['/home/someone/.momonga', '/home/someone/.cache/momonga/tmp'] };

  it('builds the macOS protection profile: everything allowed except the home areas, the command scratch allowed back', () => {
    expect(buildProtectionProfile(protection.denied, ['/home/someone/.cache/momonga/tmp/sessions/s1'])).toEqual({
      profile: [
        '(version 1)',
        '(allow default)',
        '(deny file-read* file-write* (subpath (param "HOME_DENIED_0")))',
        '(deny network-outbound (remote unix-socket (subpath (param "HOME_DENIED_0"))))',
        '(deny file-read* file-write* (subpath (param "HOME_DENIED_1")))',
        '(deny network-outbound (remote unix-socket (subpath (param "HOME_DENIED_1"))))',
        '(allow file-read* file-write* (subpath (param "SCRATCH_ALLOWED_0")))',
        '',
      ].join('\n'),
      params: { HOME_DENIED_0: '/home/someone/.momonga', HOME_DENIED_1: '/home/someone/.cache/momonga/tmp', SCRATCH_ALLOWED_0: '/home/someone/.cache/momonga/tmp/sessions/s1' },
    });
  });

  it('builds the Linux protection plan: the root bound writable, an empty tmpfs over each home area, the command scratch bound back', () => {
    expect(planProtection(protection.denied, ['/home/someone/.cache/momonga/tmp/sessions/s1'])).toEqual([
      '--bind', '/', '/',
      '--tmpfs', '/home/someone/.momonga',
      '--tmpfs', '/home/someone/.cache/momonga/tmp',
      '--bind', '/home/someone/.cache/momonga/tmp/sessions/s1', '/home/someone/.cache/momonga/tmp/sessions/s1',
    ]);
  });

  it('wraps the command per platform', () => {
    const argv = ['/bin/sh', '-c', 'true'];
    const darwin = protectionCommandOf(protection, { platform: 'darwin', argv, scratch: [], sandboxExecPath: '/usr/bin/sandbox-exec', bwrapPath: '/usr/bin/bwrap' });
    const profile = buildProtectionProfile(protection.denied, []);
    expect(darwin).toEqual({ file: '/usr/bin/sandbox-exec', args: ['-p', profile.profile, '-D', `HOME_DENIED_0=${protection.denied[0]}`, '-D', `HOME_DENIED_1=${protection.denied[1]}`, '--', ...argv] });
    const linux = protectionCommandOf(protection, { platform: 'linux', argv, scratch: [], sandboxExecPath: '/usr/bin/sandbox-exec', bwrapPath: '/usr/bin/bwrap' });
    expect(linux).toEqual({ file: '/usr/bin/bwrap', args: [...planProtection(protection.denied, []), '--', ...argv] });
    const unprotected = protectionCommandOf({ kind: 'unprotected', reason: 'none' }, { platform: 'win32', argv, scratch: [], sandboxExecPath: '/usr/bin/sandbox-exec', bwrapPath: '/usr/bin/bwrap' });
    expect(unprotected).toEqual({ file: '/bin/sh', args: ['-c', 'true'] });
  });
});

describe('the spawn port', () => {
  it('requires a protection on every launch', () => {
    expectTypeOf<GroupLaunchRequest['protection']>().toEqualTypeOf<LaunchProtection>();
    expectTypeOf<Pick<GroupLaunchRequest, 'protection'>>().toEqualTypeOf<{ protection: LaunchProtection }>();
  });
});

describe('the canonical home', () => {
  it('is the real location of a home reached through a link, the one form the protection and the verdict key use', async () => {
    const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-')));
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    try {
      expect(await canonicalHomeOf(link, testPaths())).toBe(real);
    } finally {
      fs.rmSync(link);
      fs.rmSync(real, { recursive: true });
    }
  });
});
