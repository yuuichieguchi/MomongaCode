import path from 'node:path';
import type { MarkerState, ProcessGroupPort, ProcessInspector, SignalSender, UninspectableProcess } from '@momonga/foundation';
import type { AnyTool, CallOutcome, ResultOutcome, ToolExecutorOptions } from '@momonga/tools';
import { call, makeHarness, makeTool, toolSetOf } from './harness.ts';
import type { HarnessOptions } from './harness.ts';
import { keyFor } from './helpers.ts';

const unenforced = { of: async () => 'unenforced' as const, contradicted: () => undefined };

export const LEAVER_PGID = 999_999;

export const world = (initial: MarkerState = 'held', extra: Partial<ToolExecutorOptions> = {}, runnableGroups: ReadonlySet<number> = new Set([LEAVER_PGID]), refused: readonly UninspectableProcess[] = []) => {
  const states = new Map<string, MarkerState>();
  const sent: Array<[number, NodeJS.Signals]> = [];
  const listed: AbortSignal[] = [];
  const inspector = {
    capability: unenforced,
    startTimeOf: async () => ({ kind: 'gone' }),
    groupsOf: async () => ({ kind: 'value', value: new Map() }),
    holdersOf: async (_marker: string, options: { signal: AbortSignal }, onUninspectable?: (process: UninspectableProcess) => void) => {
      listed.push(options.signal);
      for (const process of refused) onUninspectable?.(process);
      return { kind: 'value', value: [] };
    },
    markerState: async (marker: string) => states.get(path.basename(marker)) ?? initial,
  } as unknown as ProcessInspector;
  const kill: SignalSender = ((target: number, signal: NodeJS.Signals | 0) => {
    if (signal !== 0) sent.push([target, signal]);
    throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
  }) as never;
  const askedGroups: number[] = [];
  const groupPort: ProcessGroupPort = {
    signal: async () => undefined,
    alive: async (pgid) => {
      askedGroups.push(pgid);
      return runnableGroups.has(pgid);
    },
  };
  let now = 0;
  const completes: Array<{ key: string; meta: unknown }> = [];
  const harness = makeHarness({ executor: { reap: { inspector, kill, groupPort, timing: { now: () => now, sleep: async (ms: number) => void (now += ms) }, killGraceMs: 100 }, ...extra } } as HarnessOptions);
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
  return { harness, states, sent, listed, completes, askedGroups };
};

export const leaver = makeTool('Leaver', {
  kind: 'execute',
  sideEffect: 'exec',
  subjectKind: 'none',
  execute: async (_input, ctx) => {
    ctx.attachProcess({ pgid: LEAVER_PGID, startedAt: 0 });
    await ctx.markerSettle?.state(ctx.signal);
    return { status: 'completed', output: 'left something' };
  },
});
export const writer = makeTool('Writer', { sideEffect: 'write', subjectKind: 'none', execute: async () => ({ status: 'completed', output: 'wrote' }) });
export const reader = makeTool('Reader', { execute: async () => ({ status: 'completed', output: 'read' }) });

export const runOne = async (h: ReturnType<typeof world>, name: string, callId: string, extraTools: AnyTool[] = [], extra: Parameters<ReturnType<typeof world>['harness']['input']>[2] = {}): Promise<CallOutcome | undefined> => {
  const [outcome] = await h.harness.executor.runBatch(h.harness.input(await toolSetOf(leaver, writer, reader, ...extraTools), [call(callId, name, {}, 'allow_once')], extra));
  return outcome;
};

export const resultOf = (outcome: CallOutcome | undefined) => (outcome as ResultOutcome).result;

export const markerOf = (h: ReturnType<typeof world>, callId: string): string => path.join(h.harness.markerDir, keyFor('run-1', 1, callId));

