import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MINIMAL_CHILD_PATH, SECRET_PROGRAM_ENV, minimalChildEnv } from '@momonga/foundation';
import { productTestEnv, spawnTracked, testHostPath } from '@momonga/testkit';
import childProcessDefault, * as childProcessNamespace from '@momonga/testkit/child-process';
import { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync } from '@momonga/testkit/child-process';
import { INTERNAL_COMMANDS } from '../packages/cli/src/daemon/launcher.ts';
import { nodeSpawnDetached } from '../packages/cli/src/node-ports.ts';
import { secretStoreLaunchRefusal } from './support/child-process-guard.ts';

const require = createRequire(import.meta.url);
const nodeChildProcess = require('node:child_process') as typeof childProcessDefault;

const tempDir = (): string => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'guard-'));

type Decoy = { dir: string; program: string; marker: string };

const decoySecurity = (): Decoy => {
  const dir = tempDir();
  const marker = path.join(dir, 'ran');
  const program = path.join(dir, 'security');
  fs.writeFileSync(program, `#!/bin/sh\n: > '${marker}'\n`, { mode: 0o755 });
  return { dir, program, marker };
};

const expectRefusedBeforeLaunch = async (pattern: RegExp, launch: (decoy: Decoy) => unknown): Promise<void> => {
  const decoy = decoySecurity();
  try {
    let refusal: unknown;
    try {
      await launch(decoy);
    } catch (error) {
      refusal = error;
    }
    expect(String(refusal)).toMatch(pattern);
    expect(fs.existsSync(decoy.marker)).toBe(false);
  } finally {
    fs.rmSync(decoy.dir, { recursive: true, force: true });
  }
};

const REAL_PROGRAM = /\(i\) it is the real secret store program .*security, outside the fake directory/;

describe('the worker guard refuses a launch of a real secret store program (i)', () => {
  it.each([
    ['named spawn', (d: Decoy) => spawn(d.program, [], {})],
    ['named spawnSync', (d: Decoy) => spawnSync(d.program, [])],
    ['named execFile', (d: Decoy) => execFile(d.program, [])],
    ['named execFileSync', (d: Decoy) => execFileSync(d.program, [])],
    ['named exec', (d: Decoy) => exec(`'${d.program}' find-generic-password`)],
    ['named execSync', (d: Decoy) => execSync(`${d.program} find-generic-password`)],
    ['spawn with shell: true', (d: Decoy) => spawnSync(`${d.program} -i`, { shell: true })],
    ['default import', (d: Decoy) => childProcessDefault.spawn(d.program, [])],
    ['namespace import', (d: Decoy) => childProcessNamespace.spawnSync(d.program, [])],
    ['createRequire of node:child_process', (d: Decoy) => nodeChildProcess.execFileSync(d.program, [])],
    ['promisify(execFile)', (d: Decoy) => promisify(execFile)(d.program, [])],
    ['promisify of the raw execFile', (d: Decoy) => promisify(nodeChildProcess.execFile)(d.program, [])],
    ['a wrapper around spawnTracked', (d: Decoy) => spawnTracked({ onTestFinished: () => undefined }, d.program, [])],
    ['a template-literal path', (d: Decoy) => execFileSync(`${path.dirname(d.program)}/${path.basename(d.program)}`, [])],
    ['by name through a PATH spelt SESSION_PATH', (d: Decoy) => nodeChildProcess.spawnSync('security', [], { env: { PATH: `${d.dir}:/usr/bin:/bin:/usr/sbin:/sbin` } })],
    ['by name through a PATH spelt MINIMAL_CHILD_PATH', (d: Decoy) => nodeChildProcess.spawnSync('security', [], { env: { PATH: `${d.dir}:${MINIMAL_CHILD_PATH}` } })],
    ['by name through minimalChildEnv(process.env)', (d: Decoy) => nodeChildProcess.spawnSync('security', [], { env: { ...minimalChildEnv(process.env), PATH: d.dir } })],
    ['by name through an env spread from an object', (d: Decoy) => nodeChildProcess.execFileSync('security', [], { env: { ...{ PATH: d.dir } } })],
  ])('refuses before exec: %s', async (_route, launch) => {
    await expectRefusedBeforeLaunch(REAL_PROGRAM, launch);
  });

  it('decides that /usr/bin/security, by absolute path or by name through a leaking PATH or no PATH, is refused, without launching it', () => {
    expect(secretStoreLaunchRefusal('execFileSync', ['/usr/bin/security', ['-h'], {}])).toMatch(REAL_PROGRAM);
    expect(secretStoreLaunchRefusal('spawnSync', ['security', ['-h'], { env: { PATH: MINIMAL_CHILD_PATH } }])).toMatch(REAL_PROGRAM);
    expect(secretStoreLaunchRefusal('spawn', ['security', ['-h'], { env: {} }])).toMatch(REAL_PROGRAM);
    expect(secretStoreLaunchRefusal('execSync', ['/usr/bin/security -h', {}])).toMatch(REAL_PROGRAM);
  });

  it.each(['/bin/sh', 'git', 'sw_vers', process.execPath])('lets the product start %s with MINIMAL_CHILD_PATH', (command) => {
    expect(secretStoreLaunchRefusal('spawn', [command, [], { env: { PATH: MINIMAL_CHILD_PATH } }])).toBeUndefined();
  });

  it('runs /bin/sh with MINIMAL_CHILD_PATH through the raw module', () => {
    expect(nodeChildProcess.spawnSync('/bin/sh', ['-c', 'true'], { env: { PATH: MINIMAL_CHILD_PATH } }).status).toBe(0);
  });
});

describe('the worker guard refuses a given MOMONGA_SECRET_PROGRAM outside the fake directory (ii)', () => {
  it.each([
    ['spawnSync', (d: Decoy) => nodeChildProcess.spawnSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(d.marker)}, '')`], { env: { [SECRET_PROGRAM_ENV]: '/usr/bin/security' } })],
    ['fork', (d: Decoy) => fork('-e', [], { env: { [SECRET_PROGRAM_ENV]: '/usr/bin/security' }, execArgv: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(d.marker)}, '')`] })],
  ])('refuses before exec: %s', async (_route, launch) => {
    await expectRefusedBeforeLaunch(/\(ii\) its environment gives MOMONGA_SECRET_PROGRAM=\/usr\/bin\/security/, launch);
  });
});

describe('the worker guard refuses the product start of the supervisor on a leaking PATH (iii)', () => {
  const superviseArgs = (marker: string): string[] => ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`, INTERNAL_COMMANDS.supervise];

  it('nodeSpawnDetached with a hand-built PATH of /usr/bin is refused before exec', async () => {
    await expectRefusedBeforeLaunch(/\(iii\) it starts the supervisor \(__supervise\), which would choose the secret store \/usr\/bin\/security/, (d) =>
      nodeSpawnDetached({ command: process.execPath, args: superviseArgs(d.marker), env: { PATH: '/usr/bin:/bin', HOME: d.dir }, cwd: d.dir }),
    );
  });

  it('nodeSpawnDetached with productTestEnv starts', async () => {
    const decoy = decoySecurity();
    try {
      const child = nodeSpawnDetached({ command: process.execPath, args: superviseArgs(decoy.marker), env: productTestEnv({ PATH: '/usr/bin:/bin', HOME: decoy.dir }), cwd: decoy.dir });
      await child.exit;
      expect(fs.existsSync(decoy.marker)).toBe(true);
    } finally {
      fs.rmSync(decoy.dir, { recursive: true, force: true });
    }
  });
});

const PRINT_SECRET_PROGRAM = `import { findProgramOnPath } from ${JSON.stringify(path.resolve(import.meta.dirname, '../packages/foundation/src/program-search.ts'))}; process.stdout.write(JSON.stringify({ path: process.env.PATH ?? null, security: findProgramOnPath('security', process.env) ?? null }));`;

const printedBy = (stdout: string | Buffer): { path: string | null; security: string | null } => JSON.parse(String(stdout)) as { path: string | null; security: string | null };

describe('the child_process facade puts the fake secret programs first on every PATH it passes on', () => {
  const fakeBin = testHostPath('').split(path.delimiter)[0] as string;

  it.each([
    ['SESSION_PATH', { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }],
    ['MINIMAL_CHILD_PATH', { PATH: MINIMAL_CHILD_PATH }],
    ['a literal', { PATH: '/usr/bin' }],
    ['minimalChildEnv(process.env)', { ...minimalChildEnv(process.env) }],
    ['an env spread from an object', { ...{ PATH: '/usr/bin:/bin', HOME: os.tmpdir() } }],
  ])('a node child started with %s resolves security to the fake', (_spelling, env) => {
    const printed = printedBy(execFileSync(process.execPath, ['--input-type=module', '-e', PRINT_SECRET_PROGRAM], { env }));
    expect(printed.security).toBe(path.join(fakeBin, 'security'));
    expect(printed.path?.split(path.delimiter)[0]).toBe(fakeBin);
  });

  it('every launch form passes the fake first', async () => {
    const env = { PATH: MINIMAL_CHILD_PATH };
    const args = ['--input-type=module', '-e', PRINT_SECRET_PROGRAM];
    const outputs = [
      spawnSync(process.execPath, args, { env }).stdout,
      execFileSync(process.execPath, args, { env }),
      (await promisify(execFile)(process.execPath, args, { env })).stdout,
      execSync(`'${process.execPath}' --input-type=module -e ${JSON.stringify(PRINT_SECRET_PROGRAM).replaceAll('$', '\\$')}`, { env }),
    ];
    for (const output of outputs) expect(printedBy(output).security).toBe(path.join(fakeBin, 'security'));
  });

  it('an env without PATH stays without one', () => {
    expect(printedBy(execFileSync(process.execPath, ['--input-type=module', '-e', PRINT_SECRET_PROGRAM], { env: { HOME: os.tmpdir() } })).path).toBeNull();
  });
});

const IMPORT_OF_CHILD_PROCESS = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?child_process['"]|['"]node-pty['"]/;
const ROOT = path.resolve(import.meta.dirname, '..');
const ALLOWED_IMPORTERS: ReadonlySet<string> = new Set(['packages/testkit/src/child-process.ts', 'test/support/child-process-guard.ts', 'test/child-process-guard.test.ts']);

const testSources = (): string[] => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(full);
      return /\.(ts|tsx|mts|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
    });
  const packageDirs = fs.readdirSync(path.join(ROOT, 'packages')).flatMap((name) => (name === 'testkit' ? [`packages/${name}`] : [`packages/${name}/test`]));
  const scriptTests = fs.readdirSync(path.join(ROOT, 'scripts'), { recursive: true, encoding: 'utf8' }).filter((name) => name.endsWith('.test.ts')).map((name) => path.join(ROOT, 'scripts', name));
  return [...['e2e', 'test', ...packageDirs].map((dir) => path.join(ROOT, dir)).filter((dir) => fs.existsSync(dir)).flatMap(walk), ...scriptTests];
};

describe('test sources launch children only through the facade', () => {
  it('node:child_process, child_process and node-pty are imported only by the facade and the guard', () => {
    const offenders = testSources()
      .map((file) => path.relative(ROOT, file))
      .filter((file) => !ALLOWED_IMPORTERS.has(file) && IMPORT_OF_CHILD_PROCESS.test(fs.readFileSync(path.join(ROOT, file), 'utf8')));
    expect(offenders).toEqual([]);
  });
});
