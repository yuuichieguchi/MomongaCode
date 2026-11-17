import { systemProcessPorts } from '../../../gateway/src/process-ports.ts';
import { nodeFileSystemSync, systemRandom } from '@momonga/foundation';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { probeManagedFm, startGatewayProcess } from '@momonga/gateway';
import { FM_HOST_PLATFORM, REAL_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec, killGroupsForCleanup, registerOwned, testProcessInspector, testLocks, testKernelLock, TEST_UNPROTECTED_LAUNCH } from '@momonga/testkit';
import { onCleanup, writeUserSettings } from './helpers.ts';
import { GATEWAY_VERSION, launchRuntime, makeRunHome, prepareGeneration, readDb, sessionEnvFor, waitForCondition } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';
import { FIRST_GENERATION } from '@momonga/foundation';
import { createBinaryHashCache, managedInstancePaths } from '@momonga/foundation';
import { FM_SERVER } from '@momonga/protocol';
import { systemTiming } from '@momonga/foundation';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const GUARDRAIL_TRIGGER = 'FORBIDDEN-TOPIC';
const SETTLED = ['COMPLETED', 'FAILED', 'CANCELLED', 'STOPPED'];

type RunRow = { status: string; stop_reason: string | null; attempts: number };

const runRow = (temp: RunHome, runId: string): RunRow | undefined =>
  readDb<RunRow>(temp.paths.databases.runtime, 'SELECT status, stop_reason, attempts FROM runs WHERE id = ?', runId)[0];

const servePids = (dumpFile: string): number[] => {
  if (!fs.existsSync(dumpFile)) return [];
  return fs
    .readFileSync(dumpFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { argv: string[]; pid: number })
    .filter((record) => record.argv[0] === 'serve')
    .map((record) => record.pid);
};

const startFmGateway = async (temp: RunHome): Promise<void> => {
  const fm = await createFakeFm({ dir: temp.root });
  const dumpFile = path.join(temp.root, 'fm-invocations.jsonl');
  fm.configure({ envDumpFile: dumpFile, serve: { guardrailTrigger: GUARDRAIL_TRIGGER } });
  onCleanup(() => killGroupsForCleanup(servePids(dumpFile)));
  writeUserSettings(temp.home, { sandbox: 'none', models: { connections: [{ adapter: 'managed', server: 'fm', provider: 'fm', binary: fm.binaryPath, models: [{ id: 'system', toolCalling: 'native' }] }] } });
  await probeManagedFm({
    timers: systemTiming,
    inspector: testProcessInspector(), random: systemRandom, fileSystem: nodeFileSystemSync,
    launch: TEST_UNPROTECTED_LAUNCH,
    lock: testKernelLock(),
    platform: FM_HOST_PLATFORM,
    paths: temp.paths,
    instance: managedInstancePaths(temp.paths, { owner: 'cli', purpose: 'probe', provider: 'fm' } as Parameters<typeof managedInstancePaths>[1]),
    description: FM_SERVER,
    target: 'fm',
    model: 'system',
    binary: fm.binaryPath,
    readyTimeoutMs: FM_SERVER.ready.limitMs,
    env: sessionEnvFor(temp.home),
    exec: fakeExec,
    samples: 1,
    signal: new AbortController().signal,
    hashes: createBinaryHashCache(),
    isUsableBinary: async () => true,
    readStopGraceMs: () => 1_000,
    onWarning: () => undefined,
  });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  try {
    await prepareGeneration(temp);
    const gateway = await registerOwned(onCleanup, () => startGatewayProcess({...systemProcessPorts, signal: new AbortController().signal,  platform: FM_HOST_PLATFORM, locks: testLocks(), generation: FIRST_GENERATION, home: temp.home, env: sessionEnvFor(temp.home), version: GATEWAY_VERSION, exec: fakeExec }));
    onCleanup(async () => {
      await gateway.close();
    });
  } finally {
    stdout.mockRestore();
  }
};

describe('a run whose model step meets the guardrail error event the real fm sends', () => {
  it('stops with the refusal stop reason on its first attempt and is not requeued', async () => {
    const temp = makeRunHome();
    await startFmGateway(temp);
    const launched = await launchRuntime(temp);
    const session = await launched.createSession();
    const run = await launched.createRun(session.id, { input: `Tell me about ${GUARDRAIL_TRIGGER}` });

    await waitForCondition(() => {
      const row = runRow(temp, run.id);
      return row !== undefined && (SETTLED.includes(row.status) || row.attempts > 1);
    }, `run ${run.id} to settle or be requeued`);

    expect(runRow(temp, run.id)).toEqual({ status: 'STOPPED', stop_reason: 'refusal', attempts: 1 });
  });
});
