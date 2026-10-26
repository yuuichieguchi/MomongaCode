import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import type { RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { fixtureCompactionItem, materializeEvents } from '@momonga/testkit';
import { isLoop } from '../../src/worker/loop-detection.ts';
import { readRunLimits } from '../../src/worker/limits.ts';

type Item = { type: 'function_call'; callId: string; name: string; args: string } | { type: 'function_call_output'; callId: string; output: string };

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const referenceIsLoop = (items: readonly Item[], threshold: number): boolean => {
  const groups: { calls: [string, unknown][]; outputs: Map<string, string>; callIds: string[]; closed: boolean }[] = [];
  for (const item of items) {
    if (item.type === 'function_call') {
      let group = groups.at(-1);
      if (group === undefined || group.closed) {
        group = { calls: [], outputs: new Map(), callIds: [], closed: false };
        groups.push(group);
      }
      group.calls.push([item.name, parsed(item.args)]);
      group.callIds.push(item.callId);
    } else {
      const group = groups.at(-1);
      if (group === undefined) continue;
      group.closed = true;
      group.outputs.set(item.callId, item.output);
    }
  }
  const signatures = groups.map((group) => canonicalJson(group.calls));
  const outputSignatures = groups.map((group) =>
    !group.closed || group.callIds.some((callId) => !group.outputs.has(callId)) ? undefined : canonicalJson(group.callIds.map((callId) => group.outputs.get(callId))),
  );
  const current = signatures.at(-1);
  if (current === undefined) return false;
  const previous = signatures.slice(0, -1).slice(-(threshold - 1));
  const previousOutputs = outputSignatures.slice(0, -1).slice(-(threshold - 1));
  if (previous.length < threshold - 1) return false;
  const first = previousOutputs[0];
  return first !== undefined && previous.every((signature) => signature === current) && previousOutputs.every((signature) => signature === first);
};

const seeded = (seed: number) => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return { next, int: (min: number, max: number): number => min + Math.floor(next() * (max - min + 1)) };
};

const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

const randomRun = (random: ReturnType<typeof seeded>) => {
  const payloads: RunEventPayload[] = [{ type: 'user.message', text: 'loop' }];
  const items: Item[] = [];
  let callNumber = 0;
  let nextSeq = 2;
  const steps = random.int(1, 9);
  for (let step = 1; step <= steps; step += 1) {
    const width = random.int(1, 2);
    const calls = Array.from({ length: width }, () => ({ callId: `c${(callNumber += 1)}`, args: JSON.stringify({ value: `v${random.int(0, 1)}` }) }));
    payloads.push({
      type: 'model.responded',
      step,
      attempt: 1,
      response: { status: 'completed', output: calls.map((entry) => ({ type: 'function_call', id: `fc_${entry.callId}`, call_id: entry.callId, name: 'Echo', arguments: entry.args, status: 'completed' })), usage: USAGE },
    });
    for (const entry of calls) {
      items.push({ type: 'function_call', callId: entry.callId, name: 'Echo', args: entry.args });
      payloads.push({ type: 'tool.call', callId: entry.callId, providerCallId: entry.callId, name: 'Echo', kind: 'read', title: 'Echo', rawInput: parsed(entry.args) as Record<string, unknown> });
    }
    nextSeq += calls.length;
    const last = step === steps;
    for (const entry of calls) {
      if (last && random.next() < 0.5) continue;
      const output = `o${random.int(0, 1)}`;
      items.push({ type: 'function_call_output', callId: entry.callId, output });
      payloads.push({ type: 'tool.completed', callId: entry.callId, status: 'completed', output });
      nextSeq += 1;
    }
    if (!last && random.next() < 0.3) {
      payloads.push({ type: 'context.compacted', item: fixtureCompactionItem(`cmp-${step}`, 'S'), summary: 'S', replacedThroughSeq: nextSeq - 1 });
    }
  }
  return { payloads, items };
};

describe('isLoop over folded loop groups', () => {
  it('equals today\'s callGroups semantics on random histories with parallel batches and compactions', () => {
    const random = seeded(31);
    let loops = 0;
    for (let index = 0; index < 300; index += 1) {
      const { payloads, items } = randomRun(random);
      const state = materializeEvents(payloads, { runId: 'run-loop', sessionId: 'sess-loop' }).reduce(foldRunState, initialRunState({ runId: 'run-loop', sessionId: 'sess-loop' }) as RunState);
      for (const threshold of [2, 3, 4]) {
        const expected = referenceIsLoop(items, threshold);
        if (expected) loops += 1;
        expect(isLoop(state, threshold)).toBe(expected);
      }
    }
    expect(loops).toBeGreaterThan(20);
  });
});

describe('loopThreshold limit', () => {
  it('accepts 32 and rejects 33', () => {
    expect(readRunLimits({ loopThreshold: 32 }).loopThreshold).toBe(32);
    expect(() => readRunLimits({ loopThreshold: 33 })).toThrow(RangeError);
  });
});
