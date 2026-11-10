import { describe, expect, it, vi } from 'vitest';
import type { InputItem } from '@momonga/protocol';
import { callClosedBoundary, callClosedBoundaryWithWork } from '../src/token-meter.ts';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const call = (id: string): InputItem => ({ type: 'function_call', call_id: id, name: 'tool', arguments: '{}' });
const output = (id: string, text = 'ok'): InputItem => ({ type: 'function_call_output', call_id: id, output: text });
const message = (text: string): InputItem => ({ type: 'message', role: 'user', content: text });
const reasoning = (id: string): InputItem => ({ type: 'reasoning', id, summary: [] });

const commonPrefixOf = (a: readonly InputItem[], b: readonly InputItem[]): number => {
  let shared = 0;
  while (shared < a.length && shared < b.length && JSON.stringify(a[shared]) === JSON.stringify(b[shared])) shared += 1;
  return shared;
};

const closedIn = (items: readonly InputItem[], position: number): boolean => {
  const answered = new Set<string>();
  items.slice(position).forEach((item) => {
    if (item.type === 'function_call_output') answered.add(item.call_id);
  });
  return !items.slice(0, position).some((item) => item.type === 'function_call' && answered.has(item.call_id));
};

const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const sequenceOf = (random: () => number): InputItem[] => {
  const items: InputItem[] = [];
  const pending: string[] = [];
  const used: string[] = [];
  let next = 0;
  const steps = 1 + Math.floor(random() * 14);
  const freshId = (): string => {
    const id = `c${next}`;
    next += 1;
    used.push(id);
    return id;
  };
  for (let step = 0; step < steps; step += 1) {
    const roll = random();
    if (roll < 0.15) items.push(message(`m${step}`));
    else if (roll < 0.22) items.push(reasoning(`r${step}`));
    else if (roll < 0.42) {
      const id = used.length > 0 && random() < 0.2 ? (used[Math.floor(random() * used.length)] as string) : freshId();
      items.push(call(id));
      pending.push(id);
    } else if (roll < 0.47) items.push(output(`never${step}`));
    else if (roll < 0.52) {
      const id = freshId();
      items.push(output(id));
      items.push(call(id));
    } else if (pending.length > 0) {
      const index = Math.floor(random() * pending.length);
      items.push(output(pending.splice(index, 1)[0] as string));
    }
  }
  return items;
};

const rewritten = (items: readonly InputItem[], random: () => number): InputItem[] =>
  items.map((item) => (item.type === 'function_call_output' && random() < 0.3 ? output(item.call_id, 'rewritten') : item));

describe('the call-closed boundary of the meter split', () => {
  const CASES = 2000;

  it('is call-closed in both inputs, the largest such position within the common prefix, and leaves no orphan output in either suffix', () => {
    const random = seeded(20261105);
    let rewrites = 0;
    for (let index = 0; index < CASES; index += 1) {
      const a = sequenceOf(random);
      const b = random() < 0.5 ? rewritten(a, random) : [...rewritten(a, random), ...sequenceOf(random)];
      const prefix = commonPrefixOf(a, b);
      if (prefix < Math.min(a.length, b.length)) rewrites += 1;
      const j = callClosedBoundary(a, b, prefix);
      expect(j).toBeLessThanOrEqual(prefix);
      expect(closedIn(a, j)).toBe(true);
      expect(closedIn(b, j)).toBe(true);
      for (let larger = j + 1; larger <= prefix; larger += 1) expect(closedIn(a, larger) && closedIn(b, larger)).toBe(false);
      for (const items of [a, b]) {
        const calls = new Set(items.slice(0, j).flatMap((item) => (item.type === 'function_call' ? [item.call_id] : [])));
        const suffixOutputs = items.slice(j).flatMap((item) => (item.type === 'function_call_output' ? [item.call_id] : []));
        expect(suffixOutputs.some((id) => calls.has(id))).toBe(false);
      }
    }
    expect(rewrites).toBeGreaterThan(CASES / 10);
  });

  it('is the common prefix when no output crosses it, and zero when the first call is answered after it', () => {
    const a = [message('x'), call('c0'), output('c0')];
    expect(callClosedBoundary(a, a, 3)).toBe(3);
    expect(callClosedBoundary(a, [message('x'), call('c0'), output('c0', 'new')], 2)).toBe(1);
    expect(callClosedBoundary([call('c0'), output('c0')], [call('c0'), output('c0', 'new')], 1)).toBe(0);
  });

  it('puts j before the second call of a parallel batch whose own output alone is rewritten', () => {
    const a = [reasoning('r'), call('c1'), output('c1'), call('c2'), output('c2')];
    const b = [reasoning('r'), call('c1'), output('c1'), call('c2'), output('c2', 'new')];
    expect(callClosedBoundary(a, b, commonPrefixOf(a, b))).toBe(3);
  });

  it('puts j before the first call of a batch answered after both calls, when only the second output is rewritten', () => {
    const a = [reasoning('r'), call('c1'), call('c2'), output('c1'), output('c2')];
    const b = [reasoning('r'), call('c1'), call('c2'), output('c1'), output('c2', 'new')];
    expect(callClosedBoundary(a, b, commonPrefixOf(a, b))).toBe(1);
  });

  it('treats a repeated call id as one call from its first occurrence to its last output', () => {
    const a = [call('c0'), output('c0'), message('x'), call('c0'), output('c0')];
    const b = [call('c0'), output('c0'), message('x'), call('c0'), output('c0', 'new')];
    expect(callClosedBoundary(a, b, commonPrefixOf(a, b))).toBe(0);
    expect(callClosedBoundary(a, a, 4)).toBe(0);
    expect(callClosedBoundary([call('c0'), call('c0'), message('x')], [call('c0'), call('c0'), message('y')], 2)).toBe(2);
  });

  it('does not let an output without any call block a position', () => {
    const a = [message('x'), output('never'), message('y')];
    const b = [message('x'), output('never'), message('z')];
    expect(callClosedBoundary(a, b, 2)).toBe(2);
  });

  it('does not let an output that comes before its call block a position', () => {
    const a = [output('c0'), call('c0'), message('y')];
    expect(callClosedBoundary(a, a, 2)).toBe(2);
  });

  it('marks a large parallel batch in work linear in the input sizes', () => {
    const batchOf = (size: number) => {
      const ids = Array.from({ length: size }, (_, index) => `c${index}`);
      const a = [...ids.map(call), ...ids.map((id) => output(id))];
      const b = [...ids.map(call), ...ids.map((id, index) => (index === size - 1 ? output(id, 'new') : output(id)))];
      return { a, b, prefix: size * 2 - 1 };
    };
    for (const size of [5000, 10000]) {
      const { a, b, prefix } = batchOf(size);
      const { boundary, steps } = callClosedBoundaryWithWork(a, b, prefix);
      expect(boundary).toBe(0);
      expect(steps).toBeLessThanOrEqual(4 * (a.length + b.length));
    }
  });
});
