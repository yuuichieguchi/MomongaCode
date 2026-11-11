import { describe, expect, it } from 'vitest';
import type { PublicRunEvent } from '@momonga/protocol';
import { EXIT_WAITING_FOR_APPROVAL } from '@momonga/foundation';
import { createFrameSink, resultOf } from '../src/run/headless.ts';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import type { RunView } from '../src/client/views.ts';

const eventsOf = (payloads: readonly Record<string, unknown>[]): PublicRunEvent[] =>
  payloads.map((payload, index) => ({ id: index + 1, runId: 'run-1', sessionId: 'session-1', seq: index + 1, step: 1, createdAt: 1, ...payload }) as PublicRunEvent);

const headless = (payloads: readonly Record<string, unknown>[]) => {
  const err: string[] = [];
  let quiescent = 0;
  const sink = createFrameSink({ stdout: { write: () => undefined }, stderr: { write: (text: string) => void err.push(text) } } as never, 'text', false);
  sink.onQuiescent(() => {
    quiescent += 1;
  });
  for (const event of eventsOf(payloads)) sink.handle({ id: event.id, event: event.type, data: event } as RunEventFrame);
  return { lines: err.join('').split('\n').filter((line) => line.length > 0), quiescent };
};

const CALL = { type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'PullRequestMerge', kind: 'other', title: 'Merge pull request #7', rawInput: {} };

describe('headless output of a run under a mandate', () => {
  it('says what is held, why, that the run goes on, and how to answer', () => {
    const { lines } = headless([CALL, { type: 'tool.held', callId: 'c1', approvalId: 'ap-1', reason: 'PullRequestMerge always needs a person to approve it, in every mode; target: acme/widgets #7 on forge.example', footprint: { reads: [], writes: ['pr:forge.example/acme/widgets#7'] } }]);
    expect(lines).toEqual([
      'momonga: held for approval ap-1: Merge pull request #7',
      '  PullRequestMerge always needs a person to approve it, in every mode; target: acme/widgets #7 on forge.example',
      '  the run goes on with work that does not depend on it',
      '  momonga approve ap-1 allow_once',
      '  momonga approve ap-1 reject_once',
    ]);
  });

  it('reports the held calls when nothing else can proceed, and tells the follower to leave', () => {
    const { lines, quiescent } = headless([{ type: 'run.quiescent', held: [{ callId: 'c1', approvalId: 'ap-1', tool: 'PullRequestMerge', reason: 'always needs a person', sinceSeq: 9 }] }]);
    expect(lines).toEqual(['momonga: the run waits for you: 1 call held for approval, and nothing else can proceed', '  ap-1  PullRequestMerge: always needs a person', '    momonga approve ap-1 allow_once']);
    expect(quiescent).toBe(1);
    expect(EXIT_WAITING_FOR_APPROVAL).toBe(75);
  });

  it('says how a held call ended', () => {
    const { lines } = headless([CALL, { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'merged', held: { approvalId: 'ap-1' } }, { type: 'tool.held.resolved', callId: 'c1', approvalId: 'ap-1', outcome: 'rejected', status: 'failed', output: 'x' }]);
    expect(lines).toEqual(['momonga: held call Merge pull request #7 was approved and has run (completed)', 'momonga: held call Merge pull request #7 was rejected and was not run']);
  });

  it('names the dimension, the cause and the figures of an exhausted budget, money in dollars', () => {
    const { lines } = headless([{ type: 'budget.exhausted', dimension: 'cost', cause: 'cap_too_small', spent: 1_900_000_000, limit: 2_000_000_000 }]);
    expect(lines).toEqual(['momonga: budget exhausted: cost (what is left does not pay for another request); 1.9 USD of 2 USD used or reserved']);
  });
});

describe('the result of a headless run', () => {
  const run = (usage: RunView['usage']): RunView => ({ id: 'run-1', sessionId: 'session-1', status: 'STOPPED', stopReason: 'budget', step: 3, usage }) as unknown as RunView;

  it('carries the money spent in dollars and the calls with no price, when there are any', () => {
    expect(resultOf(run({ inputTokens: 1, outputTokens: 1, totalTokens: 2, costNano: 1_250_000_000, unpricedCalls: 2 }), '')).toMatchObject({ cost_usd: '1.25', unpriced_calls: 2, stop_reason: 'budget' });
    expect(resultOf(run({ inputTokens: 1, outputTokens: 1, totalTokens: 2 }), '')).not.toHaveProperty('cost_usd');
  });
});
