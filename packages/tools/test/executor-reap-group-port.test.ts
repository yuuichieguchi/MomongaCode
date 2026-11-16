import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProcessGroupPort, ProcessInspector, SignalSender } from '@momonga/foundation';
import { sleepDrivenTiming } from '@momonga/testkit';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { HarnessOptions } from './harness.ts';
import { keyFor } from './helpers.ts';

const NAME = 'd7'.repeat(16);
const PGID = 5150;
const KEY = keyFor('run-1', 1, 'call-a');

const world = () => {
  const inspector = {
    capability: { of: async () => 'unenforced' as const, contradicted: () => undefined },
    startTimeOf: async () => ({ kind: 'gone' }),
    groupsOf: async () => ({ kind: 'value', value: new Map() }),
    holdersOf: async () => ({ kind: 'value', value: [] }),
    markerState: async () => 'free',
  } as unknown as ProcessInspector;
  const sent: Array<[number, NodeJS.Signals]> = [];
  const kill: SignalSender = ((target: number, signal: NodeJS.Signals | 0) => {
    if (signal !== 0) sent.push([target, signal]);
    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  }) as never;
  const known = new Map<number, string>();
  const recalls: Array<[number, string]> = [];
  const asked: Array<[string, number]> = [];
  const groupPort: ProcessGroupPort = {
    names: {
      nameOf: (pgid) => known.get(pgid),
      recall: (pgid, name) => {
        recalls.push([pgid, name]);
        known.set(pgid, name);
      },
    },
    signal: async (pgid) => {
      if (!known.has(pgid)) throw new Error(`no job is recorded for process group ${pgid}`);
      asked.push(['signal', pgid]);
      return 'sent' as const;
    },
    alive: async (pgid) => {
      if (!known.has(pgid)) throw new Error(`no job is recorded for process group ${pgid}`);
      asked.push(['alive', pgid]);
      return false;
    },
  };
  let now = 0;
  const harness = makeHarness({ executor: { reap: { inspector, kill, groupPort, timing: sleepDrivenTiming({ now: () => now, sleep: async (ms: number) => void (now += ms) }), killGraceMs: 100 } } } as HarnessOptions);
  return { harness, sent, known, recalls, asked };
};

const noSignal = (): AbortSignal => new AbortController().signal;

describe('a stored process group is reaped through the injected group port, recalled by the name its record carries', () => {
  it('recalls the group by the name of the record and asks the port, not the host, when the marker names no job', async () => {
    const w = world();
    const record = w.harness.idempotency.seed(KEY, 'PENDING', { tool: 'Bash', runId: 'run-1' });
    Object.assign(record, { pgid: PGID, startedAt: 1, groupName: NAME });
    fs.writeFileSync(path.join(w.harness.markerDir, KEY), '', { mode: 0o600 });
    const outcomes = await w.harness.executor.abandon([{ callId: 'call-a', idemKey: KEY }], { signal: noSignal() });
    expect(outcomes).toEqual([{ idemKey: KEY, callId: 'call-a', outcome: 'unknown' }]);
    expect(w.recalls).toEqual([[PGID, NAME]]);
    expect(w.asked.some(([, pgid]) => pgid === PGID)).toBe(true);
    expect(w.sent).toEqual([]);
  });

  it('recalls nothing for a record that carries no name', async () => {
    const w = world();
    w.known.set(PGID, NAME);
    const record = w.harness.idempotency.seed(KEY, 'PENDING', { tool: 'Bash', runId: 'run-1' });
    Object.assign(record, { pgid: PGID, startedAt: 1 });
    fs.writeFileSync(path.join(w.harness.markerDir, KEY), '', { mode: 0o600 });
    await w.harness.executor.abandon([{ callId: 'call-a', idemKey: KEY }], { signal: noSignal() });
    expect(w.recalls).toEqual([]);
    expect(w.asked.some(([, pgid]) => pgid === PGID)).toBe(true);
    expect(w.sent).toEqual([]);
  });

  it('stores the name the port gives the group with the group, in the record and in the marker of the call', async () => {
    const w = world();
    w.known.set(PGID, NAME);
    let marker = '';
    const starter = makeTool('Starter', {
      kind: 'execute',
      sideEffect: 'exec',
      subjectKind: 'none',
      execute: async (_input, ctx) => {
        await ctx.attachProcess({ pgid: PGID, startedAt: 7 });
        marker = fs.readFileSync(path.join(w.harness.markerDir, ctx.idemKey), 'utf8');
        return { status: 'completed', output: 'started' };
      },
    });
    await w.harness.executor.runBatch(await w.harness.input(await toolSetOf(starter), [call('call-a', 'Starter', {}, 'allow_once')]));
    const attached = w.harness.idempotency.log.find((entry) => entry.op === 'attachProcess');
    expect(attached).toMatchObject({ op: 'attachProcess', pgid: PGID, startedAt: 7, groupName: NAME });
    expect(marker).toContain(`j${NAME}`);
  });
});
