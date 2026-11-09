import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createUninspectableRegistry } from '@momonga/foundation';
import type { ProcessInspector, ReapTiming } from '@momonga/foundation';
import { bashTool } from '../../src/builtins/bash.ts';
import type { ReconcileContext } from '../../src/types.ts';
import { call, makeHarness, makeTool, toolSetOf } from '../harness.ts';
import type { HarnessOptions } from '../harness.ts';
import { keyFor } from '../helpers.ts';

const KEY = keyFor('run-1', 1, 'call-a');

const unreadable = { pid: 31_340, command: 'ssh-agent', startTicks: '9' };

const unreadableInspector: ProcessInspector = {
  startTimeOf: async () => ({ kind: 'gone' }),
  holdersOf: async (_marker: string, ...rest: unknown[]) => {
    const report = rest.find((argument): argument is (process: typeof unreadable) => void => typeof argument === 'function');
    report?.(unreadable);
    return { kind: 'value', value: [] };
  },
  groupsOf: async () => ({ kind: 'value', value: new Map() }),
  markerState: async () => 'held',
} as unknown as ProcessInspector;

const timing: ReapTiming = { now: (() => { let now = 0; return () => (now += 25); })(), sleep: async () => undefined };

const recordingKill = () => {
  const sent: Array<[number, NodeJS.Signals | 0]> = [];
  return {
    sent,
    kill: (target: number, signal: NodeJS.Signals | 0): void => {
      if (signal !== 0) sent.push([target, signal]);
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
  };
};

describe('Bash recovery of an earlier attempt whose marker is held by a process that cannot be inspected (3H rule 3, R1)', () => {
  it('refuses as unverifiable: the marker is kept, nothing is signalled, reconcile does not run and the row stays PENDING', async () => {
    const { kill, sent } = recordingKill();
    const harness = makeHarness({ executor: { reap: { inspector: unreadableInspector, uninspectable: createUninspectableRegistry({ isAlive: () => true }), timing, killGraceMs: 100, kill: kill as never } } } as HarnessOptions);
    const marker = path.join(harness.markerDir, KEY);
    fs.writeFileSync(marker, '', { mode: 0o600 });
    harness.idempotency.seed(KEY, 'PENDING', { tool: 'Bash' });
    const seen: unknown[] = [];
    const tool = makeTool('Bash', {
      kind: 'execute',
      sideEffect: 'exec',
      subjectKind: 'none',
      reconcile: async (_input, _record, ctx) => {
        seen.push(ctx.earlierAttempt);
        return { outcome: 'unknown', output: 'unknown' };
      },
    });
    await expect(harness.executor.runBatch(harness.input(await toolSetOf(tool), [call('call-a', 'Bash', {}, 'allow_once')]))).rejects.toMatchObject({
      name: 'EarlierAttemptNotStoppedError',
      reason: 'unverifiable',
    });
    expect(seen).toEqual([]);
    expect(fs.existsSync(marker)).toBe(true);
    expect(sent).toEqual([]);
    expect(harness.idempotency.stateOf(KEY)).toBe('PENDING');
  });

  it('keeps the stopped answer when the earlier attempt was verified as stopped', async () => {
    const result = await bashTool.reconcile?.({ command: 'ssh-agent' }, { key: 'k', pgid: 4242 } as never, { earlierAttempt: { stopped: true }, processMarker: '/no/such/marker' } as ReconcileContext);
    expect(result?.output).toContain('The interrupted command was stopped.');
  });
});
