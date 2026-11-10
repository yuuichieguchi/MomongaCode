import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MINIMAL_CHILD_PATH, SECRET_PROGRAM_ENV, minimalChildEnv, nodeCommandRunner } from '@momonga/foundation';
import { fakeSecretProgramsBin, productTestEnv, spawnTracked, testHostPath } from '@momonga/testkit';
import childProcessDefault, * as childProcessNamespace from '@momonga/testkit/child-process';
import { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync } from '@momonga/testkit/child-process';
import { INTERNAL_COMMANDS, MOMONGA_LAUNCHES } from '../packages/cli/src/daemon/launcher.ts';
import type { MomongaLaunch } from '../packages/cli/src/daemon/launcher.ts';
import { nodeSpawnDetached } from '../packages/cli/src/node-ports.ts';
import { secretStoreLaunchRefusal } from './support/child-process-guard.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
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

describe('the worker guard classifies the real file behind a symbolic link', () => {
  it('refuses a link with a harmless name that points at a program of a searched name outside the fake directory', async () => {
    await expectRefusedBeforeLaunch(REAL_PROGRAM, (d) => {
      const link = path.join(d.dir, 'harmless');
      fs.symlinkSync(d.program, link);
      return nodeChildProcess.spawnSync(link, []);
    });
  });

  it('refuses that link when it is found by name through PATH', async () => {
    await expectRefusedBeforeLaunch(REAL_PROGRAM, (d) => {
      const bin = path.join(d.dir, 'linked-bin');
      fs.mkdirSync(bin);
      fs.symlinkSync(d.program, path.join(bin, 'harmless'));
      return nodeChildProcess.spawnSync('harmless', [], { env: { PATH: bin } });
    });
  });

  it('refuses an env whose MOMONGA_SECRET_PROGRAM is a link to a program outside the fake directory', async () => {
    await expectRefusedBeforeLaunch(/\(ii\) its environment gives MOMONGA_SECRET_PROGRAM=/, (d) => {
      const link = path.join(d.dir, 'given');
      fs.symlinkSync(d.program, link);
      return nodeChildProcess.spawnSync(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(d.marker)}, '')`], { env: { [SECRET_PROGRAM_ENV]: link } });
    });
  });

  it('allows a link outside the fake directory that points into it', () => {
    const dir = tempDir();
    try {
      const link = path.join(dir, 'security');
      fs.symlinkSync(path.join(fakeSecretProgramsBin(), 'security'), link);
      expect(secretStoreLaunchRefusal('spawn', [link, ['find-generic-password'], {}])).toBeUndefined();
      expect(secretStoreLaunchRefusal('spawn', [process.execPath, [], { env: { [SECRET_PROGRAM_ENV]: link } }])).toBeUndefined();
      expect(nodeChildProcess.spawnSync(link, ['find-generic-password', '-s', 'momonga', '-a', 'absent-item', '-w']).status).toBe(44);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not throw from the guard for a dangling link; the launch itself reports the missing file', () => {
    const dir = tempDir();
    try {
      const link = path.join(dir, 'security');
      fs.symlinkSync(path.join(dir, 'gone'), link);
      expect(secretStoreLaunchRefusal('spawn', [link, [], {}])).toBeUndefined();
      expect(secretStoreLaunchRefusal('spawn', [process.execPath, [], { env: { [SECRET_PROGRAM_ENV]: link } }])).toMatch(/\(ii\)/);
      expect((nodeChildProcess.spawnSync(link, []).error as NodeJS.ErrnoException).code).toBe('ENOENT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

const LAUNCHES = Object.entries(MOMONGA_LAUNCHES) as ReadonlyArray<readonly [string, MomongaLaunch]>;
const STORE_CHOOSING = LAUNCHES.filter(([, launch]) => launch.choosesSecretStoreFromPath);
const GIVEN_OR_NO_STORE = LAUNCHES.filter(([, launch]) => !launch.choosesSecretStoreFromPath);
const SELF_KINDS = ['single-binary', 'script'] as const;

describe('the worker guard refuses a product launch of a MomongaCode binary that would choose its store from a leaking PATH (iii)', () => {
  const binaryOf = (kind: (typeof SELF_KINDS)[number], args: readonly string[], decoy: Decoy): { command: string; args: readonly string[] } => {
    if (kind === 'script') {
      const script = path.join(decoy.dir, 'main.js');
      fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(decoy.marker)}, '')`);
      return { command: process.execPath, args: [script, ...args] };
    }
    const binary = path.join(decoy.dir, 'momonga');
    fs.writeFileSync(binary, `#!/bin/sh\n: > '${decoy.marker}'\n`, { mode: 0o755 });
    return { command: binary, args };
  };

  it('the product marks the supervisor start, the update check and the daemon start as choosing their store from PATH', () => {
    expect(STORE_CHOOSING.map(([name]) => name).sort()).toEqual(['startDaemon', 'supervise', 'updateCheck']);
    expect(GIVEN_OR_NO_STORE.map(([name]) => name).sort()).toEqual(['gateway', 'reportVersion', 'runtime']);
  });

  it('every internal command has a launch entry', () => {
    expect(LAUNCHES.flatMap(([, launch]) => launch.args)).toEqual(expect.arrayContaining(Object.values(INTERNAL_COMMANDS)));
  });

  it('product sources name the arguments of a MomongaCode launch only through the launcher constants', () => {
    const cliSources = fs.readdirSync(path.join(ROOT, 'packages/cli/src'), { recursive: true, encoding: 'utf8' }).filter((name) => (name.endsWith('.ts') || name.endsWith('.tsx')) && name !== 'daemon/launcher.ts');
    const literalOf = (args: readonly string[]): RegExp => new RegExp(`\\[\\s*${args.map((arg) => `['"]${arg}['"]`).join('\\s*,\\s*')}\\s*\\]`);
    const offenders = cliSources.flatMap((name) => {
      const source = fs.readFileSync(path.join(ROOT, 'packages/cli/src', name), 'utf8');
      const literalLists = LAUNCHES.filter(([, launch]) => literalOf(launch.args).test(source)).map(([launchName]) => `${name}: a literal argument list of ${launchName}`);
      const unnamedSelf = [...source.matchAll(/selfInvocation\(\s*[^,]+,\s*([^,)]+)/g)]
        .map((match) => (match[1] as string).trim())
        .filter((subcommand) => !/^(INTERNAL_COMMANDS|SUPERVISED_ROLE_COMMANDS)[.[]/.test(subcommand) && subcommand !== 'UPDATE_CHECK_COMMAND')
        .map((subcommand) => `${name}: selfInvocation with ${subcommand}`);
      return [...literalLists, ...unnamedSelf];
    });
    expect(offenders).toEqual([]);
    const install = fs.readFileSync(path.join(ROOT, 'packages/cli/src/update/install.ts'), 'utf8');
    expect(install).toContain('MOMONGA_LAUNCHES.reportVersion.args');
    expect(install).toContain('MOMONGA_LAUNCHES.startDaemon.args');
  });

  describe.each(STORE_CHOOSING)('%s', (_name, launch) => {
    it.each(SELF_KINDS)('through the real spawn port as a %s with a hand-built PATH of /usr/bin is refused before exec', async (kind) => {
      await expectRefusedBeforeLaunch(/\(iii\) it is the product launch of a MomongaCode binary with .*, which would choose the secret store \/usr\/bin\/security/, (d) =>
        nodeSpawnDetached({ ...binaryOf(kind, launch.args, d), env: { PATH: '/usr/bin:/bin', HOME: d.dir }, cwd: d.dir }),
      );
    });

    it.each(SELF_KINDS)('through the real spawn port as a %s with productTestEnv starts', async (kind) => {
      const decoy = decoySecurity();
      try {
        await nodeSpawnDetached({ ...binaryOf(kind, launch.args, decoy), env: productTestEnv({ PATH: '/usr/bin:/bin', HOME: decoy.dir }), cwd: decoy.dir }).exit;
        expect(fs.existsSync(decoy.marker)).toBe(true);
      } finally {
        fs.rmSync(decoy.dir, { recursive: true, force: true });
      }
    });
  });

  it('the update restart, through the real command runner with a hand-built PATH of /usr/bin, is refused before exec', async () => {
    await expectRefusedBeforeLaunch(/\(iii\) it is the product launch of a MomongaCode binary with daemon start/, (d) =>
      nodeCommandRunner(binaryOf('single-binary', [], d).command, MOMONGA_LAUNCHES.startDaemon.args, { env: { PATH: '/usr/bin:/bin', HOME: d.dir }, timeoutMs: 30_000, signal: new AbortController().signal }),
    );
  });

  it.each(GIVEN_OR_NO_STORE)('%s, which chooses no store from PATH, is not judged by its PATH', (_name, launch) => {
    expect(secretStoreLaunchRefusal('spawn', [process.execPath, [...launch.args], { env: { PATH: MINIMAL_CHILD_PATH } }])).toBeUndefined();
  });

  it('a program whose arguments only mention the words later is not a MomongaCode launch', () => {
    expect(secretStoreLaunchRefusal('spawn', ['/bin/echo', ['say', 'the', 'daemon', 'start'], { env: { PATH: MINIMAL_CHILD_PATH } }])).toBeUndefined();
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
