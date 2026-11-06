import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MarkerState, ProcessInspector, SignalSender } from '@momonga/foundation';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { HarnessOptions } from './harness.ts';
import { keyFor } from './helpers.ts';
import type { CallOutcome, ResultOutcome } from '@momonga/tools';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const unenforced = { of: async () => 'unenforced' as const, contradicted: () => undefined };

const world = (initial: MarkerState = 'held') => {
  const states = new Map<string, MarkerState>();
  const sent: Array<[number, NodeJS.Signals]> = [];
  const listed: AbortSignal[] = [];
  const inspector = {
    capability: unenforced,
    startTimeOf: async () => ({ kind: 'gone' }),
    groupsOf: async () => ({ kind: 'value', value: new Map() }),
    holdersOf: async (_marker: string, options: { signal: AbortSignal }) => {
      listed.push(options.signal);
      return { kind: 'value', value: [] };
    },
    markerState: async (marker: string) => states.get(path.basename(marker)) ?? initial,
  } as unknown as ProcessInspector;
  const kill: SignalSender = ((target: number, signal: NodeJS.Signals | 0) => {
    if (signal !== 0) sent.push([target, signal]);
    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  }) as never;
  const completes: Array<{ key: string; meta: unknown }> = [];
  const harness = makeHarness({ executor: { reap: { inspector, kill, timing: { now: () => 0, sleep: async () => undefined }, killGraceMs: 100 } } } as HarnessOptions);
  const port = harness.idempotency.port;
  const holding = port.holding.bind(port);
  port.holding = (fence) => {
    const leased = holding(fence);
    return {
      ...leased,
      complete: (key: string, result: unknown, meta?: unknown) => {
        completes.push({ key, meta });
        return leased.complete(key, result);
      },
    } as typeof leased;
  };
  return { harness, states, sent, listed, completes };
};

const leaver = makeTool('Leaver', {
  kind: 'execute',
  sideEffect: 'exec',
  subjectKind: 'none',
  execute: async (_input, ctx) => {
    ctx.attachProcess({ pgid: 999_999, startedAt: 0 });
    await ctx.markerSettle?.state(ctx.signal);
    return { status: 'completed', output: 'left something' };
  },
});
const writer = makeTool('Writer', { sideEffect: 'write', subjectKind: 'none', execute: async () => ({ status: 'completed', output: 'wrote' }) });
const reader = makeTool('Reader', { execute: async () => ({ status: 'completed', output: 'read' }) });

const runOne = async (h: ReturnType<typeof world>, name: string, callId: string): Promise<CallOutcome | undefined> => {
  const [outcome] = await h.harness.executor.runBatch(h.harness.input(await toolSetOf(leaver, writer, reader), [call(callId, name, {}, 'allow_once')]));
  return outcome;
};

const resultOf = (outcome: CallOutcome | undefined) => (outcome as ResultOutcome).result;

const markerOf = (h: ReturnType<typeof world>, callId: string): string => path.join(h.harness.markerDir, keyFor('run-1', 1, callId));

const SETTLED_PREFIX = (name: string) => `Not run: a process started by an earlier command (marker ${name}, unidentified) may still be running and could not be stopped. `;
const IGNORE_SUFFIX = (name: string) => `If it can stay running, ask the person to run /markers ignore ${name}.`;

describe('T8 the guard, by the sideEffect field', () => {
  it('a write call after a command left a held marker is refused with the settled-call text, and a read-only call passes', async () => {
    const h = world('held');
    expect(resultOf(await runOne(h, 'Leaver', 'first')).status).toBe('completed');
    const name = keyFor('run-1', 1, 'first');
    expect(fs.existsSync(markerOf(h, 'first'))).toBe(true);
    const refused = resultOf(await runOne(h, 'Writer', 'second'));
    expect(refused.status).toBe('failed');
    expect(refused.output.startsWith(SETTLED_PREFIX(name))).toBe(true);
    expect(refused.output).toContain('MomongaCode will try to stop it again at: ');
    expect(refused.output.endsWith(`Stop it and retry. ${IGNORE_SUFFIX(name)}`)).toBe(true);
    expect(resultOf(await runOne(h, 'Reader', 'third'))).toMatchObject({ status: 'completed', output: 'read' });
  });

  it('an exec call is refused the same way, and runs once the holder is gone and the marker is removed', async () => {
    const h = world('held');
    await runOne(h, 'Leaver', 'first');
    expect(resultOf(await runOne(h, 'Leaver', 'second')).status).toBe('failed');
    h.states.set(keyFor('run-1', 1, 'first'), 'free');
    expect(resultOf(await runOne(h, 'Leaver', 'third')).status).toBe('completed');
    expect(fs.existsSync(markerOf(h, 'first'))).toBe(false);
  });

  it('the guard spends its retry once: the record reads r10000 and a second guard signals nothing more', async () => {
    const h = world('held');
    await runOne(h, 'Leaver', 'first');
    await runOne(h, 'Writer', 'second');
    expect(fs.readFileSync(markerOf(h, 'first'), 'utf8')).toBe('r10000\n');
    const listedAfterFirst = h.listed.length;
    await runOne(h, 'Writer', 'third');
    expect(h.listed.length).toBe(listedAfterFirst);
    expect(h.sent).toEqual([]);
  });

  it('(T16 f) a marker whose state cannot be read refuses with the "could not check" text and signals nothing', async () => {
    const h = world('unknown');
    const name = 'a'.repeat(64);
    fs.writeFileSync(path.join(h.harness.markerDir, name), 'r00000\n');
    const refused = resultOf(await runOne(h, 'Writer', 'second'));
    expect(refused.status).toBe('failed');
    expect(refused.output.startsWith(`Not run: MomongaCode could not check whether a process started by an earlier command (marker ${name}) is still running. `)).toBe(true);
    expect(refused.output.endsWith(`Retry. ${IGNORE_SUFFIX(name)}`)).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it('(T17 f) a marker of an interrupted call (no ledger row) refuses with the interrupted-call text', async () => {
    const h = world('held');
    const name = 'b'.repeat(64);
    fs.writeFileSync(path.join(h.harness.markerDir, name), 'r00000\n');
    const refused = resultOf(await runOne(h, 'Writer', 'second'));
    expect(refused.output.startsWith(`Not run: a process started by an earlier command that was interrupted when MomongaCode stopped (marker ${name}, unidentified) may still be running and could not be stopped. `)).toBe(true);
  });

  it('(T17 a, f) with all four retries spent the refusal says so and nothing is listed or signalled', async () => {
    const h = world('held');
    const name = 'c'.repeat(64);
    fs.writeFileSync(path.join(h.harness.markerDir, name), 'r11110\n');
    const refused = resultOf(await runOne(h, 'Writer', 'second'));
    expect(refused.output).toContain('MomongaCode has used its four retries and will not try again.');
    expect(h.listed).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('(T17 d) the guard neither reads, reaps nor refuses on an ignored key', async () => {
    const h = world('held');
    fs.writeFileSync(path.join(h.harness.markerDir, 'd'.repeat(64)), 'r00001\n');
    expect(resultOf(await runOne(h, 'Writer', 'second'))).toMatchObject({ status: 'completed', output: 'wrote' });
    expect(h.listed).toEqual([]);
    expect(fs.readFileSync(path.join(h.harness.markerDir, 'd'.repeat(64)), 'utf8')).toBe('r00001\n');
  });
});

describe('T17 (g) decision 50 A: the recovery reap is the first attempt of an interrupted call', () => {
  it('recovery reaps once without spending a retry, and the guard still has its own retry afterwards', async () => {
    const h = world('held');
    const key = keyFor('run-1', 1, 'first');
    fs.writeFileSync(markerOf(h, 'first'), 'r00000\n');
    h.harness.idempotency.seed(key, 'PENDING', { tool: 'Leaver' });
    const recoverable = makeTool('Leaver', { kind: 'execute', sideEffect: 'exec', subjectKind: 'none', reconcile: async () => ({ outcome: 'unknown', output: 'unknown' }) });
    await h.harness.executor.runBatch(h.harness.input(await toolSetOf(recoverable, writer), [call('first', 'Leaver', {}, 'allow_once')])).catch(() => undefined);
    expect(h.listed.length).toBeGreaterThan(0);
    expect(fs.existsSync(markerOf(h, 'first'))).toBe(true);
    expect(fs.readFileSync(markerOf(h, 'first'), 'utf8')).toBe('r00000\n');
    await runOne(h, 'Writer', 'second');
    expect(fs.readFileSync(markerOf(h, 'first'), 'utf8')).toBe('r10000\n');
  });
});

describe('T14 the ledger row carries the marker state, written once by scope.complete', () => {
  it('a held-not-identified call is completed with the real status, meta.markerState held and meta.markerMode listed', async () => {
    const h = world('held');
    await runOne(h, 'Leaver', 'first');
    const key = keyFor('run-1', 1, 'first');
    expect(h.completes.filter((entry) => entry.key === key)).toEqual([{ key, meta: { markerState: 'held', markerMode: 'listed' } }]);
    expect(h.harness.idempotency.stateOf(key)).toBe('COMPLETED');
  });

  it('settleMarker writes nothing to the ledger after the row', async () => {
    const h = world('free');
    await runOne(h, 'Leaver', 'first');
    const key = keyFor('run-1', 1, 'first');
    expect(h.harness.idempotency.log.filter((entry) => entry.key === key && entry.op === 'complete')).toHaveLength(1);
    expect(h.completes.filter((entry) => entry.key === key)).toEqual([{ key, meta: { markerState: 'free', markerMode: 'listed' } }]);
    expect(fs.existsSync(markerOf(h, 'first'))).toBe(false);
  });
});

describe('T8 / T17 one removal source: MarkerSettle.remove', () => {
  it.for(['packages/tools/src/executor.ts', 'packages/tools/src/hooks/run.ts', 'packages/runtime/src/process/job-marker-files.ts', 'packages/tools/src/builtins/bash.ts', 'packages/runtime/src/process/background-jobs.ts'])('%s removes no marker itself', (relative) => {
    const text = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    expect(text.split('\n').filter((line) => /\b(rmSync|unlinkSync|promises\.rm|promises\.unlink|fs\.rm|fs\.unlink)\b/.test(line) && /marker/i.test(line))).toEqual([]);
  });
});
