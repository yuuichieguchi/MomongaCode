import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MINIMAL_CHILD_PATH, SECRET_BACKEND_ENV, SECRET_PROGRAM_ENV, createExecWithStdin, givenCredentialSecretStore, minimalChildEnv, secretStoreEnvFor } from '@momonga/foundation';
import { assertFakeSecretStoreEnv, productTestEnv, spawnProduct, spawnProductSync } from '@momonga/testkit';
import type { E2eHome } from '../e2e/support/home.ts';
import { cliEnv } from '../e2e/support/cli.ts';
import { supervisorEnv } from '../e2e/support/stack.ts';

const TEST_TEMP_ROOT = fs.realpathSync(os.tmpdir());

const chosenSecretProgram = (env: Readonly<Record<string, string | undefined>>): string | undefined => secretStoreEnvFor(env)[SECRET_PROGRAM_ENV];

const expectFakeSecretProgram = (env: Readonly<Record<string, string | undefined>>): void => {
  const program = chosenSecretProgram(env);
  expect(program, `the secret store a product process would choose from PATH=${env['PATH']}`).toBeDefined();
  expect(fs.realpathSync(program as string).startsWith(`${TEST_TEMP_ROOT}${path.sep}`), `${program} is not a fake under ${TEST_TEMP_ROOT}`).toBe(true);
};

const homeAt = (root: string): E2eHome => ({ run: '0000', tmpRoot: root, root, home: path.join(root, 'home'), project: path.join(root, 'project'), sessionTmp: path.join(root, 'tmp') }) as unknown as E2eHome;

const LEAKING_ENVS: ReadonlyArray<readonly [string, Record<string, string>]> = [
  ['PATH: SESSION_PATH', { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }],
  ['PATH: MINIMAL_CHILD_PATH', { PATH: MINIMAL_CHILD_PATH }],
  ['env: minimalChildEnv(process.env)', { ...minimalChildEnv(process.env) }],
];

describe('no process of a test run can reach the OS secret store', () => {
  it('the test process environment names a fake secret store program, so every process inheriting it does', () => {
    expectFakeSecretProgram(process.env);
  });

  it('the fake program a product process is given keeps what it writes and reads it back like the Keychain', async () => {
    const given = givenCredentialSecretStore(createExecWithStdin({ PATH: '/usr/bin:/bin' }), secretStoreEnvFor(process.env));
    expect(secretStoreEnvFor(process.env)[SECRET_BACKEND_ENV]).toBe('keychain');
    if (given.kind !== 'available') throw new Error(`no fake store was given: ${given.reason}`);
    const name = `momonga-isolation-${process.pid}`;
    await given.store.write(name, 'kept value', new AbortController().signal);
    await expect(given.store.read(name, new AbortController().signal)).resolves.toBe('kept value');
    await expect(given.store.read(`${name}-missing`, new AbortController().signal)).rejects.toThrow(/exit 44/);
  });

  it('the e2e harness gives the supervisor and the CLI a PATH whose secret store is the fake', () => {
    const home = homeAt(TEST_TEMP_ROOT);
    expectFakeSecretProgram(supervisorEnv(home, path.join(home.root, 'deps-1.json')));
    expectFakeSecretProgram(cliEnv(home));
  });



  it.each(LEAKING_ENVS)('a guarded spawn with a leaking env (%s) throws before anything runs', (_spelling, env) => {
    const marker = path.join(fs.mkdtempSync(path.join(TEST_TEMP_ROOT, 'leak-')), 'ran');
    expect(() => spawnProduct(undefined, process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`], { env })).toThrow(/resolves the secret store to .*outside the fake directory/);
    expect(() => spawnProductSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`], { env, encoding: 'utf8' })).toThrow(/outside the fake directory/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('a given MOMONGA_SECRET_PROGRAM outside the fake directory is refused too', () => {
    expect(() => assertFakeSecretStoreEnv(productTestEnv({ [SECRET_PROGRAM_ENV]: '/usr/bin/security' }), 'runtime')).toThrow(/\/usr\/bin\/security, outside the fake directory/);
  });
});
