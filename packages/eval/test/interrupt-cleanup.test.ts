import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DATASET_FORMAT, nodeWorkspaceFiles, runBenchmark, runDataset } from '@momonga/eval';
import type { BenchRunApi, EvalRunApi } from '@momonga/eval';
import type { PublicRunEvent } from '@momonga/protocol';
import { benchmarkDir, nodeProbe, ADD_FIXED } from './bench-fixtures.ts';
import { goldenCase } from './fixtures.ts';

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-interrupt-'));
  scratches.push(dir);
  return dir;
};

type Hanging = { following: Promise<void>; cancelled: string[]; events(runId: string): AsyncIterable<PublicRunEvent>; cancelRun(runId: string): Promise<void> };

const hangingRun = (): Hanging => {
  const followed = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const cancelled: string[] = [];
  return {
    following: followed.promise,
    cancelled,
    events: async function* () {
      followed.resolve();
      await ended.promise;
    },
    cancelRun: async (runId) => {
      cancelled.push(runId);
      ended.resolve();
    },
  };
};

describe('an interrupt during a run of a dataset', () => {
  it('cancels the run it started, closes what the run opened and starts no other run', async () => {
    const hanging = hangingRun();
    const interrupt = new AbortController();
    const started: string[] = [];
    let closed = 0;
    const api: EvalRunApi = {
      costs: async () => [],
      createSession: async () => ({ id: 'session-1' }),
      createRun: async () => {
        started.push(`run-${started.length + 1}`);
        return { id: `run-${started.length}` };
      },
      events: hanging.events,
      getRun: async () => {
        throw new Error('the interrupted run is not read');
      },
      answeredBy: async () => [],
      reflectionOf: async () => ({ state: 'none' }),
      resolveApproval: async () => undefined,
      cancelRun: hanging.cancelRun,
    };

    const running = runDataset(
      { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'slow', runs: 3, graders: [{ kind: 'status', equals: 'COMPLETED' }] })] },
      { open: async () => ({ api, workspace: { cwd: '/w', env: {} }, close: async () => void (closed += 1) }), signal: interrupt.signal },
    );
    await hanging.following;
    interrupt.abort();

    await expect(running).rejects.toBe(interrupt.signal.reason);
    expect(hanging.cancelled).toEqual(['run-1']);
    expect(started).toEqual(['run-1']);
    expect(closed).toBe(1);
  });

  it('starts no run when the interrupt arrived before the first', async () => {
    const interrupt = new AbortController();
    interrupt.abort();
    let opened = 0;

    const running = runDataset(
      { format: DATASET_FORMAT, name: 'live', cases: [goldenCase({ id: 'slow', graders: [{ kind: 'status', equals: 'COMPLETED' }] })] },
      {
        open: async () => {
          opened += 1;
          throw new Error('nothing is opened after an interrupt');
        },
        signal: interrupt.signal,
      },
    );

    await expect(running).rejects.toBe(interrupt.signal.reason);
    expect(opened).toBe(0);
  });
});

describe('an interrupt during a trial of the bench', () => {
  it('cancels the trial, grades nothing and starts no other trial', async () => {
    const dir = await benchmarkDir([{ id: 'fix', reference: { 'src/add.js': ADD_FIXED } }]);
    const hanging = hangingRun();
    const interrupt = new AbortController();
    const started: string[] = [];
    const probed: string[] = [];
    const api: BenchRunApi = {
      costs: async (runIds) => runIds.map((runId) => ({ runId, calls: 0, retries: 0, notPriced: 0, legacyPrecisionCalls: 0, priced: [] })),
      createSession: async () => ({ id: 'session-1' }),
      createRun: async () => {
        started.push(`run-${started.length + 1}`);
        return { id: `run-${started.length}` };
      },
      events: hanging.events,
      runOf: async () => {
        throw new Error('the interrupted trial is not read');
      },
      answeredBy: async () => [],
      resolveApproval: async () => undefined,
      cancelRun: hanging.cancelRun,
    };

    const home = scratch();
    const running = runBenchmark(path.join(dir, 'benchmark.json'), {
      open: async (task, trial) => {
        const cwd = path.join(home, `${task.id}-${trial}`);
        fs.mkdirSync(cwd);
        return { cwd, api, close: async () => undefined };
      },
      probe: { ...nodeProbe, run: async (command, timeoutMs, cwd) => (probed.push(command), nodeProbe.run(command, timeoutMs, cwd)) },
      files: nodeWorkspaceFiles,
      model: 'fake/system',
      codeDigest: 'sha256:build',
      groupBy: 'model',
      signal: interrupt.signal,
    });
    await hanging.following;
    interrupt.abort();

    await expect(running).rejects.toBe(interrupt.signal.reason);
    expect(hanging.cancelled).toEqual(['run-1']);
    expect(started).toEqual(['run-1']);
    expect(probed).toEqual([]);
  });
});
