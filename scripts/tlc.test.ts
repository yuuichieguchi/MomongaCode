import { spawn, spawnSync } from '@momonga/testkit/child-process';
import type { ChildProcess, SpawnSyncReturns } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { HAS_POSIX_SHELL } from './support/host.ts';
import { createTempRoot, removeTempRoot } from './support/temp.ts';

describe.skipIf(!HAS_POSIX_SHELL)('tlc.sh', () => {
  let root = '';
  let result: SpawnSyncReturns<string>;

  beforeAll(() => {
    root = createTempRoot();
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(`${repoRoot}scripts/tlc.sh`, path.join(root, 'scripts/tlc.sh'));
    result = spawnSync('/bin/bash', [path.join(root, 'scripts/tlc.sh'), 'RunRecovery'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' },
    });
  });

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('prints a fetch command for the exact release that carries the pinned jar, never the latest release', () => {
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('curl -L -o');
    expect(result.stderr).toContain('https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar');
    expect(result.stderr).not.toContain('latest');
  });
});

describe.skipIf(!HAS_POSIX_SHELL)('tlc.sh with a config of another module', () => {
  const tinySpec = ['---- MODULE Tiny ----', 'EXTENDS Naturals', 'VARIABLE x', 'Init == x = 0', "Next == (x < 2 /\\ x' = x + 1) \\/ (x = 2 /\\ x' = x)", 'Spec == Init /\\ [][Next]_x', 'Small == x <= 2', '===='].join('\n');
  let root = '';
  let result: SpawnSyncReturns<string>;

  beforeAll(() => {
    root = createTempRoot();
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'specs', 'tla'), { recursive: true });
    fs.mkdirSync(path.join(root, '.cache', 'tla'), { recursive: true });
    fs.copyFileSync(`${repoRoot}scripts/tlc.sh`, path.join(root, 'scripts/tlc.sh'));
    fs.symlinkSync(`${repoRoot}.cache/tla/tla2tools.jar`, path.join(root, '.cache', 'tla', 'tla2tools.jar'));
    fs.writeFileSync(path.join(root, 'specs', 'tla', 'Tiny.tla'), tinySpec);
    fs.writeFileSync(path.join(root, 'specs', 'tla', 'Tiny.small.cfg'), ['SPECIFICATION Spec', '', 'INVARIANTS', '    Small', ''].join('\n'));
    result = spawnSync('/bin/bash', [path.join(root, 'scripts/tlc.sh'), 'Tiny.small'], {
      encoding: 'utf8',
      env: process.env,
    });
  });

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('checks the module named by the part of the config name before the first dot', () => {
    expect(result.stderr).not.toContain('RunRecovery');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Model checking completed. No error has been found.');
    expect(result.stdout).toContain('3 distinct states found');
  });
});

describe.skipIf(!HAS_POSIX_SHELL)('tlc.sh --fetch-jar', () => {
  let root = '';
  const realJar = `${repoRoot}.cache/tla/tla2tools.jar`;

  const fetchJar = (url: string): SpawnSyncReturns<string> =>
    spawnSync('/bin/bash', [path.join(root, 'scripts/tlc.sh'), '--fetch-jar'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', TLC_JAR_URL: url },
    });

  const placedJar = (): string => path.join(root, '.cache', 'tla', 'tla2tools.jar');

  beforeAll(() => {
    root = createTempRoot();
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.copyFileSync(`${repoRoot}scripts/tlc.sh`, path.join(root, 'scripts/tlc.sh'));
  });

  afterAll(async () => {
    await removeTempRoot(root);
  });

  it('refuses a download whose sha256 is not the pinned one and leaves no jar behind', () => {
    const impostor = path.join(root, 'impostor.jar');
    fs.writeFileSync(impostor, 'not the jar');
    const run = fetchJar(`file://${impostor}`);
    expect(run.status).toBe(4);
    expect(run.stderr).toContain('sha256 mismatch');
    expect(fs.existsSync(placedJar())).toBe(false);
    expect(fs.existsSync(path.dirname(placedJar())) ? fs.readdirSync(path.dirname(placedJar())) : []).toEqual([]);
  });

  it.skipIf(!fs.existsSync(realJar))('places a download whose sha256 is the pinned one', () => {
    const run = fetchJar(`file://${realJar}`);
    expect(run.status).toBe(0);
    expect(fs.readFileSync(placedJar()).equals(fs.readFileSync(realJar))).toBe(true);
  });
});

describe.skipIf(!HAS_POSIX_SHELL)('tlc.sh takes the heavy run lock for more than one worker', () => {
  const nodeDir = path.dirname(process.execPath);
  let root = '';
  let state = '';
  let log = '';
  let bin = '';
  let holder: { child: ChildProcess; exit: Promise<number | null>; release: string } | undefined;

  beforeEach(() => {
    root = createTempRoot();
    state = path.join(root, 'state');
    log = path.join(root, 'java.log');
    bin = path.join(root, 'bin');
    fs.mkdirSync(path.join(root, 'sandbox', 'scripts', 'support'), { recursive: true });
    fs.mkdirSync(path.join(root, 'sandbox', 'specs', 'tla'), { recursive: true });
    fs.mkdirSync(path.join(root, 'sandbox', '.cache', 'tla'), { recursive: true });
    fs.mkdirSync(bin);
    fs.copyFileSync(`${repoRoot}scripts/tlc.sh`, path.join(root, 'sandbox', 'scripts', 'tlc.sh'));
    if (fs.existsSync(`${repoRoot}scripts/run-lock.ts`)) fs.copyFileSync(`${repoRoot}scripts/run-lock.ts`, path.join(root, 'sandbox', 'scripts', 'run-lock.ts'));
    for (const name of fs.readdirSync(`${repoRoot}scripts/support`).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts')))
      fs.copyFileSync(`${repoRoot}scripts/support/${name}`, path.join(root, 'sandbox', 'scripts', 'support', name));
    fs.symlinkSync(`${repoRoot}node_modules`, path.join(root, 'sandbox', 'node_modules'));
    fs.symlinkSync(`${repoRoot}.cache/tla/tla2tools.jar`, path.join(root, 'sandbox', '.cache', 'tla', 'tla2tools.jar'));
    fs.writeFileSync(path.join(root, 'sandbox', 'specs', 'tla', 'Stub.tla'), '');
    fs.writeFileSync(path.join(root, 'sandbox', 'specs', 'tla', 'Stub.cfg'), '');
    fs.writeFileSync(
      path.join(bin, 'java'),
      [
        '#!/bin/bash',
        'case " $* " in',
        '  *" -XshowSettings:properties "*) echo "    java.specification.version = 17" >&2 ;;',
        `  *" tlc2.TLC "*) echo "ran:\${MOMONGA_RUN_LOCK:-}" >> ${JSON.stringify(log)} ;;`,
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  });

  afterEach(async () => {
    if (holder !== undefined) {
      fs.writeFileSync(holder.release, '');
      await holder.exit;
      holder = undefined;
    }
    removeTempRoot(root);
  });

  const baseEnv = (): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'MOMONGA_RUN_LOCK') env[key] = value;
    return { ...env, MOMONGA_RUN_LOCK_WAIT_SECONDS: '0', MOMONGA_DEV_STATE_DIR: state, PATH: `${bin}${path.delimiter}${nodeDir}${path.delimiter}/usr/bin${path.delimiter}/bin` };
  };

  const tlc = (args: string[], extra: Record<string, string> = {}): SpawnSyncReturns<string> =>
    spawnSync('/bin/bash', [path.join(root, 'sandbox', 'scripts', 'tlc.sh'), ...args], { encoding: 'utf8', env: { ...baseEnv(), ...extra } });

  const logLines = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : []);

  const holdHeavy = async (): Promise<number | undefined> => {
    const release = path.join(root, 'release');
    const events = path.join(root, 'events');
    const child = spawn(process.execPath, [`${repoRoot}scripts/run-lock.ts`, 'heavy', '--', process.execPath, `${repoRoot}scripts/support/run-lock-holder.ts`, events, 'H1', release], {
      cwd: repoRoot,
      env: baseEnv(),
      stdio: 'ignore',
    });
    const exit = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    holder = { child, exit, release };
    const info = path.join(state, 'run-lock', 'heavy.info');
    while (!fs.existsSync(info)) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('the heavy holder ended before it held the lock');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return child.pid;
  };

  it.each([[['-workers', '1']], [['-workers', '0']], [[]]])('TB45 runs a one-worker call %j beside a heavy holder without the lock', async (extra) => {
    await holdHeavy();

    const run = tlc(['Stub', ...extra]);

    expect(run.status).toBe(0);
    expect(logLines()).toHaveLength(1);
    expect(run.stderr).not.toContain('run-lock:');
  });

  it('TB46 refuses a five-worker call while a heavy run holds the lock', async () => {
    await holdHeavy();

    const run = tlc(['Stub', '-workers', '5']);

    expect(run.status).toBe(71);
    expect(run.stderr).toContain('run-lock: heavy run refused: held by heavy pid ');
    expect(logLines()).toEqual([]);
  });

  it('TB47 takes the heavy lock for a five-worker call and frees it afterwards', async () => {
    const run = tlc(['Stub', '-workers', '5']);

    expect(run.status).toBe(0);
    expect(logLines()).toHaveLength(1);
    expect(logLines()[0]).toMatch(/^ran:heavy\.[0-9a-f]{16}$/);
    expect(spawnSync(process.execPath, [`${repoRoot}scripts/run-lock.ts`, 'heavy', '--', 'true'], { cwd: repoRoot, env: baseEnv() }).status).toBe(0);
  });

  it('TB48 trusts a heavy token of the right shape without checking it', () => {
    const run = tlc(['Stub', '-workers', '5'], { MOMONGA_RUN_LOCK: 'heavy.0123456789abcdef' });

    expect(run.status).toBe(0);
    expect(logLines()).toEqual(['ran:heavy.0123456789abcdef']);
  });

  it('TB49 refuses a five-worker call inside a light run', () => {
    const run = tlc(['Stub', '-workers', '5'], { MOMONGA_RUN_LOCK: 'light.0123456789abcdef' });

    expect(run.status).toBe(71);
    expect(run.stderr).toContain('run-lock: a heavy run cannot start inside a light run: this tlc.sh call uses more than one worker');
    expect(logLines()).toEqual([]);
  });

  it.each(['auto', 'x', 'abc', '2', '01', '00', '99999999999999999999'])('TB50 treats -workers %s as heavy and refuses it beside a heavy holder', async (workers) => {
    await holdHeavy();

    const run = tlc(['Stub', '-workers', workers]);

    expect(run.status).toBe(71);
    expect(logLines()).toEqual([]);
  });

  it('TB51 exits 73 for a five-worker call when node is not on PATH', () => {
    const run = tlc(['Stub', '-workers', '5'], { PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin` });

    expect(run.status).toBe(73);
    expect(run.stderr).toContain('run-lock: node is required to take the run lock for a TLC run with more than one worker');
    expect(logLines()).toEqual([]);
  });

  it('TB52 fetches and prints usage without the lock while a heavy run holds it', async () => {
    await holdHeavy();
    const impostor = path.join(root, 'impostor.jar');
    fs.writeFileSync(impostor, 'not the jar');

    const fetch = tlc(['--fetch-jar'], { TLC_JAR_URL: `file://${impostor}` });
    const usage = tlc([]);

    expect(fetch.status).toBe(4);
    expect(usage.status).toBe(2);
    expect(`${fetch.stderr}${usage.stderr}`).not.toContain('run-lock:');
  });
});
