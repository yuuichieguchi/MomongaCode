import fs from 'node:fs';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSeatbeltSandbox, createUnsandboxed } from '@momonga/sandbox';
import type { Sandbox, SandboxPolicy, SandboxedProcess } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, testKernelLock, TEST_CHILD_UNPROTECTED } from '@momonga/testkit';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const KILL_GRACE_MS = 300;
const BASE_ENV = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
const HAS_SEATBELT = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

let created: string[] = [];
let spawned: SandboxedProcess[] = [];

const tempDir = (): string => {
  const dir = fs.realpathSync(makeTempDir());
  created.push(dir);
  return dir;
};

afterEach(async () => {
  try {
    await killGroupsForCleanup(spawned.map((proc) => proc.pgid));
  } finally {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
    created = [];
    spawned = [];
  }
});

describe.runIf(HAS_SEATBELT)('seatbelt session tmp dir (real sandbox-exec)', () => {
  let work = '';
  let sessions = '';
  let mine = '';
  let other = '';
  let spawnTmpRoot = '';
  let marker = '';
  let sandbox: Sandbox;

  const policy = (): SandboxPolicy => ({
    writableRoots: [work],
    writeDenied: [sessions], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES,
    readDenied: [sessions],
    readAllowed: [mine],
    network: 'deny',
  });

  const sh = async (script: string): Promise<SandboxedProcess> => {
    const proc = await sandbox.spawn(
      { argv: ['/bin/sh', '-c', `touch '${marker}' || exit 99\n${script}`], cwd: work, env: BASE_ENV, tmpDir: mine },
      policy(),
      new AbortController().signal,
    );
    spawned.push(proc);
    return proc;
  };

  beforeEach(() => {
    const base = tempDir();
    work = path.join(base, 'work');
    sessions = path.join(base, 'cache', 'tmp', 'sessions');
    mine = path.join(sessions, 'session-1');
    other = path.join(sessions, 'session-2');
    spawnTmpRoot = path.join(base, 'spawn-tmp');
    marker = path.join(work, 'ran');
    for (const dir of [work, mine, other, spawnTmpRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(other, 'secret'), 'other-session-secret');
    sandbox = createSeatbeltSandbox({ lock: testKernelLock(), tmpRoot: spawnTmpRoot, killGraceMs: KILL_GRACE_MS });
  });

  it('sets TMPDIR to the command tmpDir and lets the command write there although its parent is write-denied', async () => {
    const result = await run(await sh(`printf '%s\\n' "$TMPDIR"; printf session-data > "$TMPDIR/f"`));
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(mine);
    expect(fs.readFileSync(path.join(mine, 'f'), 'utf8')).toBe('session-data');
  });

  it('creates no per-spawn temp dir when tmpDir is set', async () => {
    const result = await run(await sh(`ls -A '${spawnTmpRoot}' | wc -l | tr -d ' '`));
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('0');
  });

  it("denies writing into another session's tmp dir", async () => {
    const target = path.join(other, 'f');
    const result = await run(await sh(`printf x > '${target}'`));
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('denies writing directly into the sessions root', async () => {
    const target = path.join(sessions, 'stray');
    const result = await run(await sh(`printf x > '${target}'`));
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('lets /bin/realpath resolve TMPDIR', async () => {
    const result = await run(await sh('/bin/realpath "$TMPDIR"'));
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(mine);
  });

  it('lets node realpathSync resolve os.tmpdir()', async () => {
    const script = "process.stdout.write(require('fs').realpathSync(require('os').tmpdir()))";
    const result = await run(await sh(`'${process.execPath}' -e "${script}"`));
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(mine);
  });

  it('denies listing the sessions root', async () => {
    const result = await run(await sh(`ls '${sessions}'`));
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('session-2');
  });

  it("denies reading another session's file", async () => {
    const result = await run(await sh(`cat '${path.join(other, 'secret')}'`));
    expect(fs.existsSync(marker)).toBe(true);
    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('other-session-secret');
  });
});

describe.runIf(HAS_SEATBELT)('seatbelt rejects an invalid command tmpDir (real sandbox-exec)', () => {
  const fixture = () => {
    const base = tempDir();
    const home = path.join(base, 'home');
    const momonga = path.join(home, '.momonga');
    const work = path.join(base, 'work');
    const sessions = path.join(base, 'cache', 'tmp', 'sessions');
    const mine = path.join(sessions, 'session-1');
    const other = path.join(sessions, 'session-2');
    for (const dir of [momonga, work, mine, other, path.join(base, 'spawn-tmp')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const policy: SandboxPolicy = { writableRoots: [work], writeDenied: [momonga, sessions], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES, readDenied: [momonga, sessions], readAllowed: [mine], network: 'deny' };
    const sandbox = createSeatbeltSandbox({ lock: testKernelLock(), tmpRoot: path.join(base, 'spawn-tmp'), killGraceMs: KILL_GRACE_MS });
    return { base, home, work, sessions, other, policy, sandbox, marker: path.join(work, 'ran') };
  };

  const cases: Array<[string, (fx: ReturnType<typeof fixture>) => string]> = [
    ['home', (fx) => fx.home],
    ['the sessions root', (fx) => fx.sessions],
    ['/', () => '/'],
    ['a dir that is not readAllowed', (fx) => fx.other],
  ];

  for (const [label, tmpDirOf] of cases) {
    it(`rejects a tmpDir of ${label} without running the command`, async () => {
      const fx = fixture();
      const attempt = async (): Promise<void> => {
        const proc = await fx.sandbox.spawn(
          { argv: ['/bin/sh', '-c', `touch '${fx.marker}'`], cwd: fx.work, env: BASE_ENV, tmpDir: tmpDirOf(fx) },
          fx.policy,
          new AbortController().signal,
        );
        spawned.push(proc);
        await run(await proc);
      };
      await expect(attempt()).rejects.toThrow();
      expect(fs.existsSync(fx.marker)).toBe(false);
    });
  }
});

describe('unsandboxed session tmp dir', () => {
  const policy: SandboxPolicy = { writableRoots: [], writeDenied: [], protectedSet: EMPTY_PROTECTED_SET, writeDeniedLiterals: [], fileRules: EMPTY_FILE_RULES, readDenied: [], network: 'deny' };

  it('sets TMPDIR to the command tmpDir', async () => {
    const tmpDir = tempDir();
    const proc = createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform }).spawn(
      { argv: ['/bin/sh', '-c', 'printf %s "$TMPDIR"'], cwd: tmpDir, env: { ...BASE_ENV, TMPDIR: '/elsewhere' }, tmpDir },
      policy,
      new AbortController().signal,
    );
    spawned.push(await proc);
    const result = await run(await proc);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(tmpDir);
  });

  it('leaves TMPDIR from env untouched when tmpDir is absent', async () => {
    const cwd = tempDir();
    const proc = createUnsandboxed({ protection: TEST_CHILD_UNPROTECTED, platform: process.platform }).spawn(
      { argv: ['/bin/sh', '-c', 'printf %s "$TMPDIR"'], cwd, env: { ...BASE_ENV, TMPDIR: '/elsewhere' } },
      policy,
      new AbortController().signal,
    );
    spawned.push(await proc);
    const result = await run(await proc);
    expect(result.stdout).toBe('/elsewhere');
  });
});
