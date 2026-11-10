import { spawn } from '@momonga/testkit/child-process';
import type { ChildProcess } from '@momonga/testkit/child-process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reapMarkedProcesses } from '@momonga/foundation';
import type { SignalSender } from '@momonga/foundation';
import { createMarkerOwners } from '@momonga/tools';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { call, makeHarness, makeTool, toolSetOf } from '../../../tools/test/harness.ts';
import type { HarnessOptions } from '../../../tools/test/harness.ts';
import { keyFor } from '../../../tools/test/helpers.ts';
import { reapToolMarkers } from '../../src/process/tool-markers.ts';
import type { ResultOutcome } from '@momonga/tools';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const leaders: ChildProcess[] = [];

afterEach(() => {
  for (const leader of leaders.splice(0)) leader.kill('SIGKILL');
});

const store = { idempotency: { get: () => undefined, processGroupOf: () => undefined }, getRun: () => undefined } as never;

const refusingKill = (leader: () => number): SignalSender =>
  ((target: number, signal: NodeJS.Signals | 0) => {
    if (signal !== 0 && Math.abs(target) === leader()) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    process.kill(target, signal);
  }) as never;

const INTERRUPTED = (name: string) => `Not run: a process started by an earlier command that was interrupted when MomongaCode stopped (marker ${name}, `;

describe.runIf(process.platform === 'darwin')('T15 a lost call whose leader survives the crash', () => {
  it('is kept by the start-up sweep, refuses Write, Edit and Bash, is retried once by the sweep, and clears when the leader exits', async () => {
    let leaderPid = 0;
    const kill = refusingKill(() => leaderPid);
    const harness = makeHarness({ executor: { reap: { kill, killGraceMs: 100 } } } as HarnessOptions);
    const key = keyFor('run-0', 1, 'lost');
    const marker = path.join(harness.markerDir, key);
    fs.writeFileSync(marker, 'r00000\n');
    harness.idempotency.seed(key, 'PENDING', { tool: 'Bash' });
    const fd = fs.openSync(marker, 'r');
    const leader = spawn('/bin/sleep', ['60'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd] });
    fs.closeSync(fd);
    leaders.push(leader);
    await new Promise((resolve) => leader.once('spawn', resolve));
    leaderPid = leader.pid ?? 0;

    const reapWithEperm = async (options: Parameters<typeof reapMarkedProcesses>[0]) => reapMarkedProcesses({ ...options, kill });
    const sweepCalls: string[] = [];
    const counted = async (options: Parameters<typeof reapMarkedProcesses>[0]) => {
      sweepCalls.push(options.marker);
      return reapWithEperm(options);
    };
    const sweep = (event: 'startup' | 'sweep') =>
      reapToolMarkers({ dir: harness.markerDir, store, killGraceMs: 100, onWarning: () => undefined, reap: counted as never, event, owners: createMarkerOwners(), signal: new AbortController().signal } as never);

    await sweep('startup');
    expect(fs.existsSync(marker)).toBe(true);

    const tools = [
      makeTool('Write', { sideEffect: 'write', subjectKind: 'none', execute: async () => ({ status: 'completed', output: 'wrote' }) }),
      makeTool('Edit', { sideEffect: 'write', subjectKind: 'none', execute: async () => ({ status: 'completed', output: 'edited' }) }),
      makeTool('Bash', { kind: 'execute', sideEffect: 'exec', subjectKind: 'none', execute: async () => ({ status: 'completed', output: 'ran' }) }),
    ];
    const run = async (name: string, callId: string) => {
      const [outcome] = await harness.executor.runBatch(harness.input(await toolSetOf(...tools), [call(callId, name, {}, 'allow_once')]));
      return (outcome as ResultOutcome).result;
    };
    for (const [name, callId] of [['Write', 'w'], ['Edit', 'e'], ['Bash', 'b']] as const) {
      const refused = await run(name, callId);
      expect({ name, status: refused.status, interrupted: refused.output.startsWith(INTERRUPTED(key)) }).toEqual({ name, status: 'failed', interrupted: true });
    }

    const beforeSweeps = sweepCalls.length;
    await sweep('sweep');
    await sweep('sweep');
    expect(sweepCalls.length - beforeSweeps).toBe(1);
    expect(fs.existsSync(marker)).toBe(true);

    leader.kill('SIGKILL');
    await new Promise((resolve) => leader.once('exit', resolve));
    await sweep('sweep');
    expect(fs.existsSync(marker)).toBe(false);
    expect(await run('Write', 'after')).toMatchObject({ status: 'completed', output: 'wrote' });
  });
});
