import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import { JournalThreadError } from '@momonga/store';
import type { RuntimeStore } from '@momonga/store';
import { capabilitiesFor, makeEnv } from './harness.ts';
import { assistantMessage, textStep } from './scripts.ts';

const USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const WINDOW = 40_000;
const SUMMARY = 'GOAL:\ng\nSTATE:\nchecked `src/thread/token.ts`\nDONE:\nd\nTODO:\nt\nDECISIONS:\nx\nGUARDRAILS:\ny';

const responded = (step: number, output: unknown[]): RunEventPayload => ({ type: 'model.responded', step, attempt: 1, response: { status: 'completed', output, usage: USAGE } });

const journal = (): RunEventPayload[] => [
  responded(1, [assistantMessage('m1', `long ${'x'.repeat(120_000)}`)]),
  { type: 'user.message', text: 'question two' },
  responded(2, [assistantMessage('m2', 'answer two')]),
  { type: 'user.message', text: 'question three' },
  responded(3, [assistantMessage('m3', 'answer three')]),
  { type: 'user.message', text: 'question four' },
];

describe('a journal thread failure during the fidelity check', () => {
  it('requeues the claim, appends no compaction, and the retry reuses the idempotency key', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(WINDOW) });
    const run = env.enqueue('question one');
    env.seed(run.id, journal(), 'release');
    env.gateway.compactSummaries.push(SUMMARY, SUMMARY);
    env.gateway.script.push(textStep('Done.'));
    let failures = 0;
    let asked = 0;
    const store = {
      ...env.store,
      journalFacts: {
        ...env.store.journalFacts,
        fidelity: async (request: { throughEventSeq: number; tokens: { token: string }[] }) => {
          asked += 1;
          if (failures === 0) {
            failures += 1;
            throw new JournalThreadError('the journal thread exited');
          }
          return { lastSeq: request.throughEventSeq, attested: request.tokens.map((entry) => entry.token), unreadable: [] };
        },
      },
    } as unknown as RuntimeStore;
    const eventsBefore = env.events(run.id).length;

    expect(await env.runOnce(env.worker('worker-1', { store }))).toBe('yielded');

    expect(asked).toBe(1);
    expect(env.ofType(run.id, 'context.compacted')).toEqual([]);
    const requeued = env.run(run.id);
    expect(requeued.status).toBe('QUEUED');
    expect(requeued.leaseOwner).toBeNull();
    expect(env.events(run.id).filter((event) => event.type === 'context.compacted' || event.type === 'usage.charged')).toEqual([]);
    expect(env.events(run.id).length).toBeGreaterThanOrEqual(eventsBefore);

    env.clock.set(requeued.availableAt);
    expect(await env.runOnce(env.worker('worker-2', { store }))).toBe('yielded');

    expect(asked).toBe(2);
    expect(env.gateway.compacts).toHaveLength(2);
    expect(env.gateway.compacts[1]?.idempotencyKey).toBe(env.gateway.compacts[0]?.idempotencyKey);
    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(1);
    expect(env.run(run.id).status).toBe('COMPLETED');
  });
});
