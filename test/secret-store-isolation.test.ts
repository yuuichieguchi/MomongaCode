import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MINIMAL_CHILD_PATH, SECRET_BACKEND_ENV, SECRET_PROGRAM_ENV, createExecWithStdin, givenCredentialSecretStore, minimalChildEnv, secretStoreEnvFor } from '@momonga/foundation';
import { assertFakeSecretStoreEnv, productTestEnv, spawnProduct, spawnProductSync } from '@momonga/testkit';
import type { E2eHome } from '../e2e/support/home.ts';
import { cliEnv } from '../e2e/support/cli.ts';
import { supervisorEnv } from '../e2e/support/stack.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const TEST_TEMP_ROOT = fs.realpathSync(os.tmpdir());

const chosenSecretProgram = (env: Readonly<Record<string, string | undefined>>): string | undefined => secretStoreEnvFor(env)[SECRET_PROGRAM_ENV];

const expectFakeSecretProgram = (env: Readonly<Record<string, string | undefined>>): void => {
  const program = chosenSecretProgram(env);
  expect(program, `the secret store a product process would choose from PATH=${env['PATH']}`).toBeDefined();
  expect(fs.realpathSync(program as string).startsWith(`${TEST_TEMP_ROOT}${path.sep}`), `${program} is not a fake under ${TEST_TEMP_ROOT}`).toBe(true);
};

const homeAt = (root: string): E2eHome => ({ run: '0000', tmpRoot: root, root, home: path.join(root, 'home'), project: path.join(root, 'project'), sessionTmp: path.join(root, 'tmp') }) as unknown as E2eHome;

const PRODUCT_ENTRY = /\b(?:CLI_BUNDLE|CLI_FAKES_BUNDLE|SUPERVISOR_MAIN_PATH|ROLE_MAIN_PATH|buildSea|buildSeaUnsigned)\b|'bin', 'momonga'/;
const RAW_SPAWN = /(?<![\w.$])(spawn|spawnSync|execFile|execFileSync|fork|spawnTracked)\(\s*(?:context\s*,\s*)?(['"`][^'"`]*['"`])?/g;

const GUARDED_HELPERS: Readonly<Record<string, string>> = {
  'packages/testkit/src/product-spawn.ts': 'the guarded spawn helpers themselves',
  'e2e/support/cli.ts': 'startCli checks the env before it spawns the CLI',
  'e2e/support/acp.ts': 'startAcpClient checks the env before it spawns the CLI',
  'e2e/support/pty.ts': 'spawnPty checks the env before it spawns the CLI under script(1)',
  'e2e/support/stack.ts': 'spawnSupervisor checks the env before it spawns the supervisor',
};

const NOT_A_PRODUCT_SPAWN: Readonly<Record<string, string>> = {
  'e2e/global-setup.ts': 'runs scripts/bundle.ts to build the bundles; it starts no product process',
  'scripts/sea.ts': 'builds and signs the SEA binary; it starts no product process',
};

const unguardedProductSpawns = (source: string): string[] => {
  if (!PRODUCT_ENTRY.test(source)) return [];
  return [...source.matchAll(RAW_SPAWN)].filter((match) => match[2] === undefined).map((match) => `${match[1]}( at line ${source.slice(0, match.index).split('\n').length}`);
};

const walkedSources = (): string[] => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  const packageTests = fs
    .readdirSync(path.join(ROOT, 'packages'))
    .flatMap((name) => ['test', ...(name === 'testkit' ? ['src'] : [])].map((dir) => path.join(ROOT, 'packages', name, dir)))
    .filter((dir) => fs.existsSync(dir));
  return [path.join(ROOT, 'e2e'), path.join(ROOT, 'scripts'), path.join(ROOT, 'test'), ...packageTests].flatMap(walk);
};

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

  it.each(['PATH: SESSION_PATH', 'PATH: MINIMAL_CHILD_PATH', 'env: minimalChildEnv(process.env)'])('the walk stops a raw spawn of a product entry whatever its env spelling (%s)', (spelling) => {
    const source = `const child = spawn(process.execPath, [CLI_BUNDLE, 'mcp', 'list'], { ${spelling.startsWith('PATH') ? `env: { ${spelling} }` : spelling} });`;
    expect(unguardedProductSpawns(source)).toHaveLength(1);
  });

  it('every spawn of a product entry in the test sources goes through a guarded helper', () => {
    const offenders = walkedSources().flatMap((file) => {
      const relative = path.relative(ROOT, file);
      if (relative === 'test/secret-store-isolation.test.ts' || Object.hasOwn(GUARDED_HELPERS, relative) || Object.hasOwn(NOT_A_PRODUCT_SPAWN, relative)) return [];
      return unguardedProductSpawns(fs.readFileSync(file, 'utf8')).map((found) => `${relative}: ${found}`);
    });
    expect(offenders).toEqual([]);
  });

  it('every guarded helper checks the env before it spawns', () => {
    const unchecked = Object.keys(GUARDED_HELPERS).filter((file) => !/assertFakeSecretStoreEnv\(/.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(unchecked).toEqual([]);
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
