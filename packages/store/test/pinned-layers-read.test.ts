import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload } from '@momonga/protocol';
import { enqueue, harness, mustClaim, newSession } from './helpers.ts';

const SYSTEM = { type: 'message', role: 'system', content: 'Be careful.' };
const HISTORY = { type: 'function_call_output', call_id: 'c1', output: 'x'.repeat(2000) };

const requested = (step: number, pinnedDigest: string | undefined, extra: readonly unknown[] = []): RunEventPayload =>
  ({
    type: 'model.requested',
    step,
    attempt: 1,
    digest: `digest-${step}`,
    ...(pinnedDigest === undefined ? {} : { pinnedDigest }),
    body: { model: 'fm', input: [SYSTEM, ...extra, { type: 'message', role: 'user', content: 'hi' }, HISTORY], tools: [{ type: 'function', name: 'Read' }], tool_choice: 'auto' },
  }) as RunEventPayload;

const D1 = 'a'.repeat(64);
const D2 = 'b'.repeat(64);

const readSteps = (payloads: readonly RunEventPayload[]): { steps: number[]; bodies: unknown[] } => {
  const seen: RunEvent[] = [];
  const h = harness({
    contribution: {
      eventTypes: ['model.requested'],
      measure: ({ events }) => {
        seen.push(...events);
        return undefined;
      },
    },
  });
  enqueue(h.store, newSession(h.store).id);
  const claim = mustClaim(h.store, 'w1');
  expect(h.store.append(claim, [...payloads]).kind).toBe('ok');
  expect(h.store.transition(claim, ['RUNNING'], 'COMPLETED').kind).toBe('ok');
  return { steps: seen.map((event) => event.step), bodies: seen.map((event) => (event.type === 'model.requested' ? event.body : undefined)) };
};

describe('reading the pinned layers of the recorded requests at a terminal', () => {
  it('reads a request only when its pinned-layer digest differs from every one already read', () => {
    const { steps } = readSteps([requested(1, D1), requested(2, D1), requested(3, D2), requested(4, D1), requested(5, D2)]);
    expect(steps).toEqual([1, 3]);
  });

  it('reads in full every request that records no digest', () => {
    const { steps } = readSteps([requested(1, undefined), requested(2, D1), requested(3, undefined), requested(4, D1)]);
    expect(steps).toEqual([1, 2, 3]);
  });

  it('hands the hook the pinned layers and the tools of a request, not its history', () => {
    const developer = { type: 'message', role: 'developer', content: 'Instruction file.' };
    const { bodies } = readSteps([requested(1, D1, [developer])]);
    expect(bodies).toEqual([{ input: [SYSTEM, developer], tools: [{ type: 'function', name: 'Read' }], tool_choice: 'auto' }]);
  });
});
