import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECRET_BACKEND_ENV, SECRET_PROGRAM_ENV, createExecWithStdin, givenCredentialSecretStore, secretStoreEnvFor } from '@momonga/foundation';
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

const PRODUCT_ENTRY_REFERENCES = /\b(CLI_BUNDLE|CLI_FAKES_BUNDLE|SUPERVISOR_MAIN_PATH|seaBinary|binary)\b/;
const PATH_ASSIGNMENT = /(?:\bPATH\s*:|_PATH\s*=)/;
const OS_DIRECTORY_IN_PATH = /(?:['"`:]|^)(?:\/usr)?\/s?bin(?=[:'"`\s])/;
const HANDS_OS_PATH = (line: string): boolean => PATH_ASSIGNMENT.test(line) && OS_DIRECTORY_IN_PATH.test(line.replace(/testHostPath\([^)]*\)/g, ''));

const testSourcesSpawningEntries = (): string[] => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'fixtures' ? [] : walk(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  return [...walk(path.join(ROOT, 'e2e')), ...fs.readdirSync(path.join(ROOT, 'scripts')).filter((name) => name.endsWith('.test.ts')).map((name) => path.join(ROOT, 'scripts', name))].filter((file) => {
    const source = fs.readFileSync(file, 'utf8');
    return PRODUCT_ENTRY_REFERENCES.test(source) && /\b(spawn|spawnTracked|execFile|execFileSync)\(/.test(source);
  });
};

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

  it('no test source that spawns a product entry hands it a literal OS PATH', () => {
    const offenders = testSourcesSpawningEntries().flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return source
        .split('\n')
        .flatMap((line, index) => (HANDS_OS_PATH(line) ? [`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`] : []));
    });
    expect(offenders).toEqual([]);
  });
});
