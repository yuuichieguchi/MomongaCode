import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MINIMAL_CHILD_PATH, SECRET_STORE_SEARCHED_PROGRAMS, URL_OPENER_PROGRAMS, createBrowserOpener, findProgramOnPath, nodeFileSystem, openCommandFor, urlOpenerFileFor } from '@momonga/foundation';
import {
  REAL_PROCESS_TEST_TIMEOUT_MS,
  TEST_OPENER_RECORD_ENV,
  createFakePrograms,
  fakeBrowserOf,
  fakeOpenerRecordOf,
  fakeSecretProgramsBin,
  installFakePrograms,
  posixEnvLine,
  productTestEnv,
  readOpenerRecord,
  removeFakePrograms,
  testHostPath,
  withTempDir,
} from '@momonga/testkit';
import type { LaunchProgram, ProgramEnd } from '@momonga/foundation';
import type { FakePrograms } from '@momonga/testkit';
import childProcessDefault, { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync } from '@momonga/testkit/child-process';
import { cliEnv } from '../e2e/support/cli.ts';
import type { E2eHome } from '../e2e/support/home.ts';
import { supervisorEnv } from '../e2e/support/stack.ts';
import { launchProgram } from '../packages/cli/src/node-ports.ts';
import { launchRefusal } from './support/child-process-guard.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const require = createRequire(import.meta.url);
const nodeChildProcess = require('node:child_process') as typeof childProcessDefault;

const URL_TO_OPEN = new URL('https://example.test/sign-in?state=a b&next=%2Fhome');
const STAND_INS = [...URL_OPENER_PROGRAMS, 'browser'];
const FAKE_OPENER_MAIN = path.resolve(import.meta.dirname, '../packages/testkit/src/fake-opener-main.ts');

const isInside = (directory: string, file: string): boolean => {
  const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(file));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const expectStandIn = (file: string | undefined): void => {
  expect(file, 'a program to open a URL').toBeDefined();
  expect(isInside(fakeSecretProgramsBin(), file as string), `${file} is not a stand-in of ${fakeSecretProgramsBin()}`).toBe(true);
};

describe('the stand-ins for the programs that open a URL', () => {
  const created: FakePrograms[] = [];

  afterEach(() => {
    for (const programs of created.splice(0)) removeFakePrograms(programs.root, programs.token);
  });

  const privatePrograms = (): FakePrograms => {
    const programs = createFakePrograms();
    created.push(programs);
    return programs;
  };

  it('the run installs one for every program the product looks for, beside the fake secret programs, and BROWSER names one', async () => {
    const bin = fakeSecretProgramsBin();
    expect(URL_OPENER_PROGRAMS).toEqual(['xdg-open', 'open', 'rundll32']);
    for (const program of [...URL_OPENER_PROGRAMS, ...SECRET_STORE_SEARCHED_PROGRAMS]) expect(await findProgramOnPath(program, process.env, nodeFileSystem)).toBe(path.join(bin, program));
    expect(process.env['BROWSER']).toBe(fakeBrowserOf(bin));
    expect(fs.readdirSync(bin).sort()).toEqual([...STAND_INS, ...SECRET_STORE_SEARCHED_PROGRAMS].sort());
  });

  it('what the product chooses in the worker, with and without BROWSER, is a stand-in', async () => {
    expect(await openCommandFor(URL_TO_OPEN, process.env, nodeFileSystem)).toEqual({ file: fakeBrowserOf(fakeSecretProgramsBin()), args: [URL_TO_OPEN.toString()] });
    expectStandIn(await urlOpenerFileFor(process.env, nodeFileSystem));
    expectStandIn(await urlOpenerFileFor({ ...process.env, BROWSER: undefined }, nodeFileSystem));
  });

  it('the directory of the run and everything a program in it could be replaced through is writable by its owner only', () => {
    const bin = fakeSecretProgramsBin();
    const root = path.dirname(bin);
    for (const directory of [root, bin, path.join(root, 'items')]) expect(fs.statSync(directory).mode & 0o777, directory).toBe(0o700);
    for (const program of fs.readdirSync(bin)) expect(fs.statSync(path.join(bin, program)).mode & 0o022, program).toBe(0);
    expect(fs.statSync(root).uid).toBe(process.getuid?.());
  });

  it.for(STAND_INS)('the stand-in %s appends its argument vector to the record it is given and exits 0', (program, context) => {
    const record = path.join(withTempDir(context), 'opened');
    const args = program === 'rundll32' ? ['url.dll,FileProtocolHandler', URL_TO_OPEN.toString()] : [URL_TO_OPEN.toString()];
    const env = { ...productTestEnv(), [TEST_OPENER_RECORD_ENV]: record };
    expect(spawnSync(path.join(fakeSecretProgramsBin(), program), args, { env, encoding: 'utf8' })).toMatchObject({ status: 0, stdout: '', stderr: '' });
    expect(spawnSync(path.join(fakeSecretProgramsBin(), program), ['second'], { env }).status).toBe(0);
    expect(readOpenerRecord(record)).toEqual([
      { program, args },
      { program, args: ['second'] },
    ]);
    expect(fs.statSync(record).mode & 0o777).toBe(0o600);
  });

  it('a stand-in that is given no record keeps its calls in the directory it was installed in', () => {
    const programs = privatePrograms();
    expect(readOpenerRecord(fakeOpenerRecordOf(programs.bin))).toEqual([]);
    expect(spawnSync(process.execPath, [FAKE_OPENER_MAIN, path.join(programs.root, 'items'), 'open', URL_TO_OPEN.toString()], { env: { PATH: MINIMAL_CHILD_PATH } }).status).toBe(0);
    expect(readOpenerRecord(fakeOpenerRecordOf(programs.bin))).toEqual([{ program: 'open', args: [URL_TO_OPEN.toString()] }]);
    expect(fs.readdirSync(programs.root).sort()).toEqual(['.momonga-fake-secret-programs', 'bin', 'items']);
  });

  it('a simulated Windows PATHEXT lookup resolves every stand-in in the directory', async () => {
    const programs = privatePrograms();
    const windows = path.join(programs.root, 'items', 'windows');
    fs.mkdirSync(windows);
    const bin = installFakePrograms(windows, 'win32');
    for (const program of URL_OPENER_PROGRAMS) expect(await findProgramOnPath(program, { PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, nodeFileSystem)).toBe(path.join(bin, `${program}.cmd`));
  });

  it('the one line the install script prints sets PATH and BROWSER for a POSIX shell', () => {
    const programs = privatePrograms();
    const printed = execFileSync('/bin/sh', ['-c', `${posixEnvLine(programs.bin)}; command -v open; printenv BROWSER; printenv PATH`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).trim().split('\n');
    expect(printed.slice(0, 2)).toEqual([path.join(programs.bin, 'open'), fakeBrowserOf(programs.bin)]);
    expect(printed[2]?.split(path.delimiter)[0]).toBe(programs.bin);
  });
});

const homeAt = (root: string): E2eHome => ({ run: '0000', tmpRoot: root, root, home: path.join(root, 'home'), project: path.join(root, 'project'), sessionTmp: path.join(root, 'tmp') }) as unknown as E2eHome;

describe('every environment a test gives a product process chooses a stand-in', () => {
  it('productTestEnv, whatever PATH and BROWSER it is given', async () => {
    expectStandIn(await urlOpenerFileFor(productTestEnv(), nodeFileSystem));
    expectStandIn(await urlOpenerFileFor(productTestEnv({ PATH: '/usr/bin:/bin' }), nodeFileSystem));
    expect(productTestEnv({ PATH: '/usr/bin:/bin', BROWSER: '/usr/bin/open' })['BROWSER']).toBe(fakeBrowserOf(fakeSecretProgramsBin()));
  });

  it('the e2e harness gives the supervisor, the CLI and the pty a stand-in and a record under the home of the test', async (context) => {
    const home = homeAt(withTempDir(context));
    expectStandIn(await urlOpenerFileFor(supervisorEnv(home, path.join(home.root, 'deps-1.json')), nodeFileSystem));
    expectStandIn(await urlOpenerFileFor(cliEnv(home), nodeFileSystem));
    expectStandIn(await urlOpenerFileFor(cliEnv(home, { BROWSER: '/usr/bin/open' }), nodeFileSystem));
    expect(cliEnv(home)[TEST_OPENER_RECORD_ENV]).toBe(path.join(home.root, 'opened-by-stand-in.log'));
  });
});

const PRINT_OPENER = `import { urlOpenerFileFor } from ${JSON.stringify(path.resolve(import.meta.dirname, '../packages/foundation/src/open-browser.ts'))}; import { nodeFileSystem } from ${JSON.stringify(path.resolve(import.meta.dirname, '../packages/foundation/src/node-file-system.ts'))}; process.stdout.write(JSON.stringify({ opener: (await urlOpenerFileFor(process.env, nodeFileSystem)) ?? null }) + '\\n');`;
const PRINT_ARGS = ['--input-type=module', '-e', PRINT_OPENER];

const openerPrintedIn = (stdout: string | Buffer): string | undefined => {
  const printed: unknown = JSON.parse(String(stdout));
  return typeof printed === 'object' && printed !== null && 'opener' in printed && typeof printed.opener === 'string' ? printed.opener : undefined;
};

const stdoutOfSpawned = (child: ReturnType<typeof spawn>): Promise<string> =>
  new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', reject);
    child.once('close', () => resolve(stdout));
  });

describe('the child_process facade puts the stand-ins first on the PATH of every child, with or without an environment argument', () => {
  const shellCommand = `'${process.execPath}' --input-type=module -e ${JSON.stringify(PRINT_OPENER).replaceAll('$', '\\$')}`;

  it.each([
    ['spawnSync without options', () => spawnSync(process.execPath, PRINT_ARGS).stdout],
    ['spawnSync with options and no env', () => spawnSync(process.execPath, PRINT_ARGS, { cwd: process.cwd() }).stdout],
    ['spawnSync with an env that has a PATH', () => spawnSync(process.execPath, PRINT_ARGS, { env: { PATH: MINIMAL_CHILD_PATH } }).stdout],
    ['spawnSync with an undefined options argument', () => spawnSync(process.execPath, PRINT_ARGS, undefined).stdout],
    ['execFileSync without options', () => execFileSync(process.execPath, PRINT_ARGS)],
    ['execSync without options', () => execSync(shellCommand)],
    ['execSync with options and no env', () => execSync(shellCommand, { cwd: process.cwd() })],
    ['spawn without options', () => stdoutOfSpawned(spawn(process.execPath, PRINT_ARGS))],
    ['spawn with stdio only', () => stdoutOfSpawned(spawn(process.execPath, PRINT_ARGS, { stdio: ['ignore', 'pipe', 'inherit'] }))],
    ['the default import', () => childProcessDefault.spawnSync(process.execPath, PRINT_ARGS).stdout],
    ['execFile with a callback and no options', () => new Promise<string>((resolve, reject) => execFile(process.execPath, PRINT_ARGS, (error, stdout) => (error === null ? resolve(stdout) : reject(error))))],
    ['exec with a callback and no options', () => new Promise<string>((resolve, reject) => exec(shellCommand, (error, stdout) => (error === null ? resolve(stdout) : reject(error))))],
    ['promisify(execFile) without options', async () => (await promisify(execFile)(process.execPath, PRINT_ARGS)).stdout],
    ['promisify(exec) without options', async () => (await promisify(exec)(shellCommand)).stdout],
  ])('%s', async (_form, run) => {
    vi.stubEnv('PATH', MINIMAL_CHILD_PATH);
    vi.stubEnv('BROWSER', undefined);
    try {
      expectStandIn(openerPrintedIn(await run()));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fork without options', async (context) => {
    const script = path.join(withTempDir(context), 'print-opener.mjs');
    fs.writeFileSync(script, PRINT_OPENER);
    vi.stubEnv('PATH', MINIMAL_CHILD_PATH);
    vi.stubEnv('BROWSER', undefined);
    try {
      expectStandIn(openerPrintedIn(await stdoutOfSpawned(fork(script, [], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] }))));
      expectStandIn(openerPrintedIn(await stdoutOfSpawned(fork(script, { silent: true }))));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('an env without PATH stays without one, and the product finds no opener in it', () => {
    expect(openerPrintedIn(execFileSync(process.execPath, PRINT_ARGS, { env: { HOME: process.cwd() } }))).toBeUndefined();
  });
});

type Decoy = { dir: string; opener: string; marker: string };

const decoyOpener = (dir: string, name: string): Decoy => {
  const marker = path.join(dir, 'ran');
  const opener = path.join(dir, name);
  fs.writeFileSync(opener, `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o755 });
  return { dir, opener, marker };
};

const WRITE_MARKER = (marker: string): string[] => ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`];

const refusalOf = (launch: () => unknown): string => {
  try {
    launch();
  } catch (error) {
    return String(error);
  }
  return '';
};

describe('the worker guard refuses a child that could reach a real program that opens a URL', () => {
  const REAL_OPENER = /\(v\) it is the real program that opens a URL .*, outside the fake directory/;
  const GIVEN_BROWSER = /\(vi\) its environment gives BROWSER=.*, outside the fake directory/;
  const INHERITED_OPENER = /\(vii\) it inherits the environment of the test process, in which the product would open a URL with .*, outside the fake directory/;

  it.for(URL_OPENER_PROGRAMS)('refuses before exec a child that inherits the environment of the test process when its PATH lost the stand-ins and holds a planted %s', (program, context) => {
    const decoy = decoyOpener(withTempDir(context), program);
    vi.stubEnv('PATH', decoy.dir);
    vi.stubEnv('BROWSER', undefined);
    try {
      expect(refusalOf(() => nodeChildProcess.spawnSync(process.execPath, WRITE_MARKER(decoy.marker)))).toMatch(INHERITED_OPENER);
      expect(refusalOf(() => nodeChildProcess.execFileSync(process.execPath, WRITE_MARKER(decoy.marker), { cwd: decoy.dir }))).toMatch(INHERITED_OPENER);
      expect(refusalOf(() => nodeChildProcess.execSync(`: > '${decoy.marker}'`))).toMatch(INHERITED_OPENER);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fs.existsSync(decoy.marker)).toBe(false);
  });

  it('refuses before exec a child that inherits the environment of the test process when a planted program comes before the stand-in the product would choose', (context) => {
    const [first] = URL_OPENER_PROGRAMS;
    const decoy = decoyOpener(withTempDir(context), first as string);
    vi.stubEnv('PATH', `${decoy.dir}${path.delimiter}${process.env['PATH']}`);
    vi.stubEnv('BROWSER', undefined);
    try {
      expect(refusalOf(() => nodeChildProcess.spawnSync(process.execPath, WRITE_MARKER(decoy.marker)))).toMatch(INHERITED_OPENER);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fs.existsSync(decoy.marker)).toBe(false);
  });

  it('refuses before exec a child whose environment, inherited or given, names a BROWSER outside the fake directory', (context) => {
    const decoy = decoyOpener(withTempDir(context), 'my-browser');
    expect(refusalOf(() => nodeChildProcess.spawnSync(process.execPath, WRITE_MARKER(decoy.marker), { env: { PATH: testHostPath(), BROWSER: decoy.opener } }))).toMatch(GIVEN_BROWSER);
    expect(refusalOf(() => spawnSync(process.execPath, WRITE_MARKER(decoy.marker), { env: { PATH: MINIMAL_CHILD_PATH, BROWSER: decoy.opener } }))).toMatch(GIVEN_BROWSER);
    vi.stubEnv('BROWSER', decoy.opener);
    try {
      expect(refusalOf(() => spawnSync(process.execPath, WRITE_MARKER(decoy.marker)))).toMatch(GIVEN_BROWSER);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fs.existsSync(decoy.marker)).toBe(false);
  });

  it.for(URL_OPENER_PROGRAMS)('refuses before exec a direct launch of a real %s, by path, by name through a leaking PATH, and behind a link with another name', (program, context) => {
    const decoy = decoyOpener(withTempDir(context), program);
    const link = path.join(decoy.dir, 'harmless');
    fs.symlinkSync(decoy.opener, link);
    expect(refusalOf(() => nodeChildProcess.spawnSync(decoy.opener, [URL_TO_OPEN.toString()]))).toMatch(REAL_OPENER);
    expect(refusalOf(() => nodeChildProcess.spawnSync(program, [URL_TO_OPEN.toString()], { env: { PATH: `${decoy.dir}${path.delimiter}${MINIMAL_CHILD_PATH}` } }))).toMatch(REAL_OPENER);
    expect(refusalOf(() => nodeChildProcess.execSync(`'${decoy.opener}' ${JSON.stringify(URL_TO_OPEN.toString())}`))).toMatch(REAL_OPENER);
    expect(refusalOf(() => nodeChildProcess.execFileSync(link, [URL_TO_OPEN.toString()]))).toMatch(REAL_OPENER);
    expect(fs.existsSync(decoy.marker)).toBe(false);
  });

  it('decides that a launch of the stand-in, of a tool with the minimal PATH of the product, and of a program whose arguments only mention an opener are not refused', () => {
    const bin = fakeSecretProgramsBin();
    expect(launchRefusal('spawn', [path.join(bin, 'open'), [URL_TO_OPEN.toString()], {}])).toBeUndefined();
    expect(launchRefusal('spawn', [fakeBrowserOf(bin), [URL_TO_OPEN.toString()], {}])).toBeUndefined();
    expect(launchRefusal('spawn', ['git', ['status'], { env: { PATH: MINIMAL_CHILD_PATH } }])).toBeUndefined();
    expect(launchRefusal('spawn', ['/bin/sh', ['-c', 'echo open; exec 3< /dev/null'], { env: { PATH: MINIMAL_CHILD_PATH } }])).toBeUndefined();
    expect(launchRefusal('spawn', [process.execPath, ['-e', '0'], {}])).toBeUndefined();
    expect(launchRefusal('spawn', [process.execPath, ['-e', '0'], { env: productTestEnv() }])).toBeUndefined();
  });

  it('the opener port of the product, started in the test process, runs the stand-in once with the URL and nothing else', async (context) => {
    const record = path.join(withTempDir(context), 'opened');
    const failures: string[] = [];
    const ended = Promise.withResolvers<ProgramEnd>();
    vi.stubEnv(TEST_OPENER_RECORD_ENV, record);
    try {
      const launch: LaunchProgram = (file, args) => {
        const end = launchProgram(file, args);
        ended.resolve(end);
        return end;
      };
      createBrowserOpener({ env: process.env, launch, files: nodeFileSystem })(URL_TO_OPEN, new AbortController().signal, (message) => failures.push(message));
      expect(await ended.promise).toEqual({ exitCode: 0, signal: null });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(readOpenerRecord(record)).toEqual([{ program: 'browser', args: [URL_TO_OPEN.toString()] }]);
    expect(failures).toEqual([]);
  });
});
