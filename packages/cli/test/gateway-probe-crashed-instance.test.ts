import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createManagedServer } from '@momonga/gateway';
import { ensureMomongaDirs, momongaLayout } from '@momonga/foundation';
import { FM_SERVER } from '@momonga/protocol';
import { REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec, killGroupsForCleanup, registerCleanup, spawnTracked, testKernelLock, testProcessInspector, withTempDir } from '@momonga/testkit';
import type { CleanupContext } from '@momonga/testkit';
import { cliProbeInstance } from '../src/commands/gateway.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const HOLDER = path.join(import.meta.dirname, 'probe-instance-holder-entry.ts');

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
};

const servePidsOf = (dumpFile: string): number[] =>
  fs.existsSync(dumpFile)
    ? fs
        .readFileSync(dumpFile, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as { argv: string[]; pid: number })
        .filter((record) => record.argv[0] === 'serve')
        .map((record) => record.pid)
    : [];

const prepared = async (context: CleanupContext) => {
  const home = withTempDir(context, { asHome: true });
  const paths = momongaLayout(home, process.platform, {});
  await ensureMomongaDirs(paths);
  const fm = await createFakeFm({ dir: home });
  const dumpFile = path.join(home, 'env.jsonl');
  fm.configure({ envDumpFile: dumpFile });
  registerCleanup(context, () => killGroupsForCleanup(servePidsOf(dumpFile)));
  return { home, instance: cliProbeInstance(paths, 'apple'), binary: fm.binaryPath, dumpFile };
};

const startHolder = (context: CleanupContext, home: string, binary: string) =>
  new Promise<ReturnType<typeof spawnTracked>>((resolve, reject) => {
    const child = spawnTracked(context, process.execPath, [HOLDER, home, binary, testKernelLock().name], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    (child.stderr as Readable).on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    (child.stdout as Readable).on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('started')) resolve(child);
    });
    child.once('exit', (code) => reject(new Error(`the probing process ended (code ${code}) before its server started: ${stderr}`)));
  });

const nextProbe = (context: CleanupContext, at: Awaited<ReturnType<typeof prepared>>) => {
  const warnings: string[] = [];
  const server = createManagedServer({
    inspector: testProcessInspector(),
    lock: testKernelLock(),
    description: { ...FM_SERVER, restart: { ...FM_SERVER.restart, maxRestarts: 0 } },
    target: 'apple',
    lockPath: at.instance.lockPath,
    socketPath: at.instance.socketPath,
    markerDirectory: at.instance.markerDirectory,
    readyTimeoutMs: 15_000,
    readStopGraceMs: () => 1000,
    binary: at.binary,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: at.home, TMPDIR: at.home },
    exec: fakeExec,
    onWarning: (message) => warnings.push(message),
  });
  registerCleanup(context, () => server.stop());
  return { server, warnings };
};

describe.runIf(process.platform !== 'win32')('the instance _cli-probe-<provider> of a crashed command line is reaped by the next probe of that provider (20.66)', () => {
  it('ends the managed server group the crashed probe left, clears its socket and starts its own', async (context) => {
    const at = await prepared(context);
    const holder = await startHolder(context, at.home, at.binary);
    const [left] = servePidsOf(at.dumpFile);
    if (left === undefined) throw new Error('the crashed probe started no server');
    holder.kill('SIGKILL');
    await new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    expect(isAlive(left)).toBe(true);

    const { server } = nextProbe(context, at);
    await server.start();

    expect(isAlive(left)).toBe(false);
    const serving = servePidsOf(at.dumpFile).filter((pid) => pid !== left);
    expect(serving).toHaveLength(1);
    expect(fs.readdirSync(at.instance.markerDirectory)).toHaveLength(1);
  });
});
