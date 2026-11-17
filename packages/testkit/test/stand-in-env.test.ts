import path from 'node:path';
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { MINIMAL_CHILD_PATH, SECRET_BACKEND_ENV, SECRET_PROGRAM_ENV, URL_OPENER_PROGRAMS, findProgramOnPath, nodeFileSystem, secretStoreEnvFor } from '@momonga/foundation';
import { fakeBrowserOf, fakeSecretProgramsBin, productTestEnv, standInEnv } from '@momonga/testkit';

const SESSION_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

describe('the environment of a product process started by a test', () => {
  it.each([
    ['standInEnv', () => standInEnv(SESSION_PATH)],
    ['productTestEnv', () => productTestEnv({ PATH: SESSION_PATH })],
  ])('%s puts the stand-ins first on PATH and names the stand-in browser in BROWSER', async (_name, build) => {
    const env = build();
    const bin = fakeSecretProgramsBin();
    expect(env['PATH']?.split(path.delimiter)[0]).toBe(bin);
    expect(env['PATH']?.split(path.delimiter).slice(1)).toEqual(SESSION_PATH.split(path.delimiter));
    expect(env['BROWSER']).toBe(fakeBrowserOf(bin));
    for (const program of URL_OPENER_PROGRAMS) {
      expect(await findProgramOnPath(program, { PATH: env['PATH'] ?? '' }, nodeFileSystem), program).toBe(path.join(bin, program));
    }
  });

  it.each([
    ['standInEnv', () => standInEnv(SESSION_PATH)],
    ['productTestEnv', () => productTestEnv({ PATH: SESSION_PATH })],
  ])('%s names a D-Bus session bus, so the Linux secret store chooser takes the fake secret-tool', async (_name, build) => {
    const env = build();
    const bin = fakeSecretProgramsBin();
    expect(env['DBUS_SESSION_BUS_ADDRESS']).toBeTruthy();
    const linux = { platform: 'linux' as const, uid: process.getuid?.(), realPathOf: (file: string) => fs.realpathSync(file) };
    const chosen = await secretStoreEnvFor(env, linux);
    expect(chosen[SECRET_BACKEND_ENV]).toBe('secret-service');
    expect(chosen[SECRET_PROGRAM_ENV]).toBe(path.join(bin, 'secret-tool'));
  });

  it('keeps the minimal PATH behind the stand-ins when no PATH is given', () => {
    expect(standInEnv().PATH).toBe([fakeSecretProgramsBin(), MINIMAL_CHILD_PATH].join(path.delimiter));
  });
});
