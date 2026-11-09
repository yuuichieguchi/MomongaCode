import { describe, expect, it } from 'vitest';
import { flush, ownedHarness, settled } from './derived-fixture.ts';
import type { Built, Lease } from './derived-fixture.ts';

type OpName = 'admitOp' | 'acquireOp';
type Action = { kind: 'edit' } | { kind: 'start'; op: OpName } | { kind: 'abort'; op: OpName } | { kind: 'release'; op: OpName } | { kind: 'finish' } | { kind: 'fail' };

type Op = {
  phase: 'idle' | 'waiting' | 'holding';
  controller: AbortController;
  outcome: ReturnType<typeof settled<Lease<Built>>> | undefined;
  lease: Lease<Built> | undefined;
  target: number;
};

const DEPTH = 5;
const OPS: readonly OpName[] = ['admitOp', 'acquireOp'];

const labelOf = (action: Action): string => ('op' in action ? `${action.kind}(${action.op})` : action.kind);

const bootstrap = async () => {
  const h = ownedHarness();
  const first = h.derivation.acquire(new AbortController().signal);
  await flush();
  h.gates.shift()?.release();
  (await first).release();
  await flush();
  const ops: Record<OpName, Op> = {
    admitOp: { phase: 'idle', controller: new AbortController(), outcome: undefined, lease: undefined, target: 0 },
    acquireOp: { phase: 'idle', controller: new AbortController(), outcome: undefined, lease: undefined, target: 0 },
  };
  return { h, ops };
};

type World = Awaited<ReturnType<typeof bootstrap>>;

const enabled = ({ h, ops }: World): Action[] => {
  const actions: Action[] = [{ kind: 'edit' }];
  for (const op of OPS) {
    if (ops[op].phase === 'idle') actions.push({ kind: 'start', op });
    if (ops[op].phase === 'waiting') actions.push({ kind: 'abort', op });
    if (ops[op].phase === 'holding') actions.push({ kind: 'release', op });
  }
  if (h.gates.length > 0) actions.push({ kind: 'finish' }, { kind: 'fail' });
  return actions;
};

const absorb = (ops: Record<OpName, Op>): void => {
  for (const op of OPS) {
    const state = ops[op];
    if (state.phase !== 'waiting' || state.outcome === undefined) continue;
    if (state.outcome.outcome === 'resolved') {
      state.phase = 'holding';
      state.lease = state.outcome.value;
    } else if (state.outcome.outcome === 'rejected') {
      state.phase = 'idle';
      state.controller = new AbortController();
    }
  }
};

const step = async (world: World, action: Action, trace: string): Promise<void> => {
  const { h, ops } = world;
  const warningsBefore = h.warnings.length;
  const waitingBefore = OPS.filter((op) => ops[op].phase === 'waiting');
  const finishing = h.gates[0];
  const finishingVersion = h.derived.at(-1)?.version;
  if (action.kind === 'edit') h.edit();
  if (action.kind === 'start') {
    const state = ops[action.op];
    state.target = h.version();
    state.phase = 'waiting';
    const call = action.op === 'admitOp' ? h.derivation.admit(state.controller.signal) : h.derivation.acquire(state.controller.signal);
    state.outcome = settled(call);
  }
  if (action.kind === 'abort') ops[action.op].controller.abort(new Error(`abort of ${action.op}`));
  if (action.kind === 'release') {
    ops[action.op].lease?.release();
    ops[action.op].lease = undefined;
    ops[action.op].phase = 'idle';
  }
  if (action.kind === 'finish') h.gates.shift()?.release();
  if (action.kind === 'fail') h.gates.shift()?.fail(new Error('derive failed'));
  await flush();
  absorb(ops);

  expect(h.gates.length, `${trace}: at most one derivation in flight`).toBeLessThanOrEqual(1);
  expect(new Set(h.retired).size, `${trace}: each object is retired once`).toBe(h.retired.length);
  for (const op of OPS) {
    const lease = ops[op].lease;
    if (lease !== undefined) expect(h.retired, `${trace}: an object held by ${op} is not retired`).not.toContain(lease.value);
  }
  if (action.kind === 'abort') {
    expect(ops[action.op].phase, `${trace}: the aborted caller is detached`).toBe('idle');
    for (const other of waitingBefore.filter((op) => op !== action.op)) expect(ops[other].phase, `${trace}: an abort leaves ${other} waiting`).toBe('waiting');
    expect(h.warnings.length, `${trace}: an abort is not reported`).toBe(warningsBefore);
    expect(h.gates[0], `${trace}: an abort leaves the flight running`).toBe(finishing);
  }
  if (action.kind === 'finish') {
    for (const op of waitingBefore) {
      if (ops[op].target !== finishingVersion) continue;
      expect(ops[op].phase, `${trace}: ${op} takes its lease in the completion step`).toBe('holding');
      expect(ops[op].lease?.value.version).toBe(finishingVersion);
    }
  }
  if (action.kind === 'fail') {
    if (waitingBefore.includes('admitOp') && ops.admitOp.target === finishingVersion) expect(ops.admitOp.phase, `${trace}: admit rejects with the failure`).toBe('idle');
    if (waitingBefore.includes('acquireOp') && ops.acquireOp.target === finishingVersion) {
      expect(ops.acquireOp.phase, `${trace}: acquire gets the previous object`).toBe('holding');
      expect(ops.acquireOp.lease?.value.version).toBeLessThan(finishingVersion ?? 0);
    }
  }
  if (action.kind !== 'fail') expect(h.warnings.length, `${trace}: only a derive failure is reported`).toBe(warningsBefore);
};

const replay = async (prefix: readonly Action[]): Promise<World> => {
  const world = await bootstrap();
  const labels: string[] = [];
  for (const action of prefix) {
    labels.push(labelOf(action));
    await step(world, action, labels.join(' > '));
  }
  return world;
};

const sequences = async (prefix: Action[], found: Action[][]): Promise<void> => {
  if (prefix.length === DEPTH) {
    found.push(prefix);
    return;
  }
  const world = await replay(prefix);
  for (const action of enabled(world)) await sequences([...prefix, action], found);
};

describe('createPinnedDerivation conforms to SettingsSwap.tla over every action sequence of depth 5 (design-settings-live 15.6)', () => {
  it('every enumerated sequence keeps the model invariants after each step', { timeout: 600_000 }, async () => {
    const found: Action[][] = [];
    await sequences([], found);
    expect(found.length).toBeGreaterThan(1000);
  });
});
