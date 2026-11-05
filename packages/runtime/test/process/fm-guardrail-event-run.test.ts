import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startGatewayProcess } from '@momonga/gateway';
import { DAEMON_PROCESS_TEST_TIMEOUT_MS, createFakeFm, fakeExec, killGroupsForCleanup } from '@momonga/testkit';
import { onCleanup, writeUserSettings } from './helpers.ts';
import { GATEWAY_VERSION, launchRuntime, makeRunHome, readDb, sessionEnvFor, waitForCondition } from './run-helpers.ts';
import type { RunHome } from './run-helpers.ts';

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };
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
  writeUserSettings(temp.home, { sandbox: 'none', models: { aliases: { default: ['fm'] }, targets: { fm: { adapter: 'fm', toolCalling: 'native' } } } });
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
  try {
    const gateway = await startGatewayProcess({ home: temp.home, env: sessionEnvFor(temp.home), version: GATEWAY_VERSION, fmBinary: fm.binaryPath, exec: fakeExec });
    onCleanup(async () => {
      await gateway.close();
    });
  } finally {
    stdout.mockRestore();
  }
};

describe('a run whose model step meets the guardrail error event the real fm sends', () => {
  it('stops with the refusal stop reason on its first attempt and is not requeued', PROCESS_TIMEOUT, async () => {
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
