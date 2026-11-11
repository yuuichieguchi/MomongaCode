import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { nodeFileSystem, systemRandom } from '@momonga/foundation';
import { createSeatbeltSandbox } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeClock, testKernelLock, testProcessInspector, unconfiguredNetworkOf } from '@momonga/testkit';
import { execFileSync } from '@momonga/testkit/child-process';
import * as runtime from '@momonga/runtime';
import { createPolicyFilesystem, createSandboxedArgvRunner, nodeShellHost } from '@momonga/tools';
import { HAS_SEATBELT, inertSandbox, makeTempHome, signalNever } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PROBE_BOUND_MS = 60_000;

describe('the sandbox of a Git reconcile', () => {
  it('is built by the builder of the normal path from the roots of the session, without the session tmp dir as a root', async () => {
    const temp = await makeTempHome();
    const tmpDir = path.join(temp.paths.tmp.sessions, 'session-1');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const reconcileSandbox = runtime.createReconcileSandbox({
      paths: temp.paths,
      home: temp.home,
      sandboxes: runtime.fixedSandboxBindings(inertSandbox),
      fs: createPolicyFilesystem(),
    });
    const project = fs.realpathSync(temp.project);

    const held = await reconcileSandbox({
      idemKey: 'key-1',
      clock: createFakeClock(0),
      deadlineAt: Number.MAX_SAFE_INTEGER,
      signal: signalNever(),
      roots: [project, fs.realpathSync(tmpDir)],
      tmpDir: fs.realpathSync(tmpDir),
      random: systemRandom,
      files: nodeFileSystem,
    });
    held.release();

    expect(held.sandboxPolicy.writableRoots).toContain(project);
    expect(held.sandboxPolicy.protectedSet).toBeDefined();
  });
});

describe.runIf(HAS_SEATBELT)('a Git probe of a reconcile in the real sandbox', () => {
  it('runs on every attempt with the roots of the session, the session tmp dir among them', async () => {
    const temp = await makeTempHome();
    const project = fs.realpathSync(temp.project);
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: project, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: temp.home, GIT_CONFIG_NOSYSTEM: '1' } }).trim();
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(project, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base');
    const head = git('rev-parse', 'HEAD');
    const tmpDir = path.join(temp.paths.tmp.sessions, 'session-1');
    fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
    const realTmp = fs.realpathSync(tmpDir);
    const markerDir = path.join(temp.root, 'markers');
    fs.mkdirSync(markerDir);
    const runArgv = createSandboxedArgvRunner({
      reconcileSandbox: runtime.createReconcileSandbox({
        paths: temp.paths,
        home: temp.home,
        sandboxes: runtime.fixedSandboxBindings(createSeatbeltSandbox({ lock: testKernelLock(), tmpRoot: temp.paths.tmp.spawn, killGraceMs: 300 })),
        fs: createPolicyFilesystem(),
      }),
      shellHost: nodeShellHost(),
      outboundNetwork: unconfiguredNetworkOf,
      markerDir,
      credentialRoot: temp.paths.tmp.spawn,
      inspector: testProcessInspector(),
    });
    const clock = createFakeClock(0);
    const attempt = async (idemKey: string) =>
      runArgv(['git', 'rev-parse', 'HEAD'], {
        cwd: project,
        env: { PATH: '/usr/bin:/bin', HOME: temp.home },
        signal: signalNever(),
        network: 'none',
        effect: false,
        context: { idemKey, clock, deadlineAt: clock.now() + PROBE_BOUND_MS, signal: signalNever(), roots: [project, realTmp], tmpDir: realTmp, random: systemRandom, files: nodeFileSystem },
      });

    const first = await attempt('key-1');
    const second = await attempt('key-1');

    expect(first).toEqual({ exitCode: 0, stdout: `${head}\n`, stderr: '' });
    expect(second).toEqual(first);
  });
});
