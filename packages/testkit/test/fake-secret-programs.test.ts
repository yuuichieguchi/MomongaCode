import { execFileSync, spawn, spawnSync } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { SECRET_STORE_SEARCHED_PROGRAMS, createExecWithStdin, createSecretServiceStore, findProgramOnPathSync, nodeFileSystemSync } from '@momonga/foundation';
import {
  createFakePrograms,
  fakeSecretProgramsBin,
  REAL_PROCESS_TEST_TIMEOUT_MS,
  getFakeSecretEnded,
  getFakeSecretHanging,
  installFakePrograms,
  removeFakePrograms,
  resetFakeSecretControl,
  setFakeSecretControl,
  waitFor,
} from '@momonga/testkit';
import type { FakeControl, FakePrograms } from '@momonga/testkit';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const roots: string[] = [];
const freshRoot = (): string => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fake-secret-programs-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const WINDOWS_PATHEXT = '.COM;.EXE;.BAT;.CMD';

describe('installFakePrograms', () => {
  it.each(SECRET_STORE_SEARCHED_PROGRAMS)('installs a fake %s that the PATH lookup of this host finds in the fake directory', (program) => {
    const bin = installFakePrograms(freshRoot());
    expect(findProgramOnPathSync(program, { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` }, nodeFileSystemSync)).toBe(path.join(bin, program));
  });

  it.each(SECRET_STORE_SEARCHED_PROGRAMS)('installs a fake %s.cmd that a simulated Windows PATHEXT lookup resolves in the fake directory; starting it is not verified on a Windows host', (program) => {
    const bin = installFakePrograms(freshRoot(), 'win32');
    const found = findProgramOnPathSync(program, { PATH: bin, PATHEXT: WINDOWS_PATHEXT }, nodeFileSystemSync);
    expect(found).toBe(path.join(bin, `${program}.cmd`));
    expect(fs.readFileSync(found as string, 'utf8')).toContain(JSON.stringify(process.execPath).slice(1, -1));
  });

  it('the fake secret-tool of the run keeps what it stores and looks it up like the Secret Service', async () => {
    const bin = fakeSecretProgramsBin();
    const store = createSecretServiceStore(createExecWithStdin({ PATH: '/usr/bin:/bin' }), path.join(bin, 'secret-tool'));
    await store.write(`isolation-${process.pid}`, 'stored value', new AbortController().signal);
    await expect(store.read(`isolation-${process.pid}`, new AbortController().signal)).resolves.toBe('stored value');
  });

  it('the fake cmdkey of the run, which has no protocol fake, refuses every call loudly', () => {
    const bin = fakeSecretProgramsBin();
    let failure: { status: number | null; stderr: string } | undefined;
    try {
      execFileSync(path.join(bin, 'cmdkey'), ['/list'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      failure = error as { status: number | null; stderr: string };
    }
    expect(failure?.status).not.toBe(0);
    expect(failure?.stderr).toMatch(/fake cmdkey: no fake of this program's protocol exists/);
  });
});

const FAKE_PROGRAM_MAIN = path.join(import.meta.dirname, '..', 'src', 'fake-secret-program-main.ts');
const ROOT_ENTRIES = ['.momonga-fake-secret-programs', 'bin', 'items'];

describe('the fake security program and its control file', () => {
  const created: FakePrograms[] = [];

  afterEach(() => {
    for (const programs of created.splice(0)) removeFakePrograms(programs.root, programs.token);
  });

  const privatePrograms = (): FakePrograms & { items: string } => {
    const programs = createFakePrograms();
    created.push(programs);
    return { ...programs, items: path.join(programs.root, 'items') };
  };

  const runSecurity = (items: string, args: readonly string[]): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(process.execPath, [FAKE_PROGRAM_MAIN, items, 'security', ...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  it('the program fake prints a path of a file it created', () => {
    const programs = privatePrograms();
    const keychain = path.join(programs.items, '.login.keychain-db');
    expect(fs.existsSync(keychain)).toBe(false);
    expect(runSecurity(programs.items, ['default-keychain'])).toEqual({ status: 0, stdout: `    "${keychain}"\n`, stderr: '' });
    expect(fs.statSync(keychain).isFile()).toBe(true);
    expect(fs.statSync(keychain).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(keychain, 'utf8')).toBe('');
    expect(runSecurity(programs.items, ['default-keychain'])).toEqual({ status: 0, stdout: `    "${keychain}"\n`, stderr: '' });
    expect(fs.readdirSync(programs.root).sort()).toEqual(ROOT_ENTRIES);
  });

  it('the keychain file and the control file are not items', () => {
    const programs = privatePrograms();
    setFakeSecretControl({ readiness: 'ready' }, programs.bin);
    runSecurity(programs.items, ['default-keychain']);
    expect(runSecurity(programs.items, ['find-generic-password', '-s', 'momonga', '-a', '.control', '-w']).status).toBe(44);
    expect(runSecurity(programs.items, ['find-generic-password', '-s', 'momonga', '-a', '.login.keychain-db', '-w']).status).toBe(44);
  });

  it.for([
    ['none', { status: 1, stdout: '', stderr: 'security: SecKeychainCopyDefault: A default keychain could not be found.\n' }],
    ['garbage', { status: 0, stdout: 'garbage\n', stderr: '' }],
  ] as const)('the program fake answers none, gone, garbage by its control file (%s)', ([readiness, answer]) => {
    const programs = privatePrograms();
    setFakeSecretControl({ readiness }, programs.bin);
    expect(runSecurity(programs.items, ['default-keychain'])).toEqual(answer);
    expect(fs.existsSync(path.join(programs.items, '.login.keychain-db'))).toBe(false);
    expect(fs.readdirSync(programs.root).sort()).toEqual(ROOT_ENTRIES);
  });

  it('the program fake answers none, gone, garbage by its control file (gone)', () => {
    const programs = privatePrograms();
    const missing = path.join(programs.items, '.missing.keychain-db');
    setFakeSecretControl({ readiness: 'gone' }, programs.bin);
    expect(runSecurity(programs.items, ['default-keychain'])).toEqual({ status: 0, stdout: `    "${missing}"\n`, stderr: '' });
    expect(fs.existsSync(missing)).toBe(false);
    expect(fs.existsSync(path.join(programs.items, '.login.keychain-db'))).toBe(false);
  });

  it('the control file is read at every invocation, across processes', () => {
    const programs = privatePrograms();
    const ready = { status: 0, stdout: `    "${path.join(programs.items, '.login.keychain-db')}"\n`, stderr: '' };
    expect(runSecurity(programs.items, ['default-keychain'])).toEqual(ready);
    setFakeSecretControl({ readiness: 'none' }, programs.bin);
    expect(runSecurity(programs.items, ['default-keychain']).status).toBe(1);
    setFakeSecretControl({ readiness: 'ready' }, programs.bin);
    expect(runSecurity(programs.items, ['default-keychain'])).toEqual(ready);
    setFakeSecretControl({ readiness: 'garbage' }, programs.bin);
    expect(runSecurity(programs.items, ['default-keychain']).stdout).toBe('garbage\n');
    resetFakeSecretControl(programs.bin);
    expect(runSecurity(programs.items, ['default-keychain'])).toEqual(ready);
    expect(fs.readdirSync(programs.root).sort()).toEqual(ROOT_ENTRIES);
  });

  it('the control file is one JSON object written whole, with the unset part ready', () => {
    const programs = privatePrograms();
    setFakeSecretControl({ calls: 'hang' }, programs.bin);
    expect(JSON.parse(fs.readFileSync(path.join(programs.items, '.control'), 'utf8'))).toEqual({ readiness: 'ready', calls: 'hang' });
    setFakeSecretControl({ readiness: 'gone' }, programs.bin);
    expect(JSON.parse(fs.readFileSync(path.join(programs.items, '.control'), 'utf8'))).toEqual({ readiness: 'gone', calls: 'answer' });
    expect(fs.readdirSync(programs.items).sort()).toEqual(['.control']);
    resetFakeSecretControl(programs.bin);
    resetFakeSecretControl(programs.bin);
    expect(fs.readdirSync(programs.items)).toEqual([]);
  });

  it('a readiness answer other than ready leaves the item calls answering', () => {
    const programs = privatePrograms();
    fs.writeFileSync(path.join(programs.items, 'kept'), 'kept value', { mode: 0o600 });
    setFakeSecretControl({ readiness: 'none' }, programs.bin);
    expect(runSecurity(programs.items, ['find-generic-password', '-s', 'momonga', '-a', 'kept', '-w'])).toEqual({ status: 0, stdout: 'kept value\n', stderr: '' });
  });

  it('no program has ended or hung before one was made to hang', () => {
    const programs = privatePrograms();
    runSecurity(programs.items, ['default-keychain']);
    expect(getFakeSecretEnded(programs.bin)).toEqual([]);
    expect(getFakeSecretHanging(programs.bin)).toEqual([]);
  });

  it.for([
    ['the readiness call', { readiness: 'hang' }, 'security', ['default-keychain']],
    ['an item call of security', { calls: 'hang' }, 'security', ['find-generic-password', '-s', 'momonga', '-a', 'k', '-w']],
    ['an item call of secret-tool', { calls: 'hang' }, 'secret-tool', ['lookup', 'service', 'momonga', 'account', 'k']],
  ] as const)('a hanging program ends when its caller ends it and records it (%s)', async ([, control, program, args], context) => {
    const programs = privatePrograms();
    setFakeSecretControl(control, programs.bin);
    const child = spawn(process.execPath, [FAKE_PROGRAM_MAIN, programs.items, program, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
    context.onTestFinished(() => void child.kill('SIGKILL'));
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    const line = [program, ...args].join(' ');
    await waitFor(() => getFakeSecretHanging(programs.bin).length === 1 || child.exitCode !== null, { description: `the fake ${program} reports that it hangs` });
    expect(getFakeSecretHanging(programs.bin)).toEqual([`hanging ${line}`]);
    expect(child.exitCode).toBeNull();
    expect(getFakeSecretEnded(programs.bin)).toEqual([]);
    child.kill('SIGTERM');
    expect(await exited).toEqual({ code: 143, signal: null });
    expect(getFakeSecretEnded(programs.bin)).toEqual([`ended ${line}`]);
    expect(output).toBe('');
    expect(fs.readdirSync(programs.root).sort()).toEqual(ROOT_ENTRIES);
  });

  it('the control helpers require the root they act on', () => {
    expectTypeOf(setFakeSecretControl).parameters.toEqualTypeOf<[control: Partial<FakeControl>, bin: string]>();
    expectTypeOf(resetFakeSecretControl).parameters.toEqualTypeOf<[bin: string]>();
    expectTypeOf(getFakeSecretEnded).parameters.toEqualTypeOf<[bin: string]>();
    expectTypeOf(getFakeSecretHanging).parameters.toEqualTypeOf<[bin: string]>();
    expect([setFakeSecretControl.length, resetFakeSecretControl.length, getFakeSecretEnded.length, getFakeSecretHanging.length]).toEqual([2, 1, 1, 1]);
  });

  it('a control file written under one root does not change the answer of a program under another root', () => {
    const changed = privatePrograms();
    const other = privatePrograms();
    setFakeSecretControl({ readiness: 'none' }, changed.bin);
    expect(runSecurity(changed.items, ['default-keychain']).status).toBe(1);
    expect(runSecurity(other.items, ['default-keychain'])).toEqual({ status: 0, stdout: `    "${path.join(other.items, '.login.keychain-db')}"\n`, stderr: '' });
    expect(fs.existsSync(path.join(other.items, '.control'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(fakeSecretProgramsBin()), 'items', '.control'))).toBe(false);
  });
});
