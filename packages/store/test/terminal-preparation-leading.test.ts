import { describe, expect, it } from 'vitest';
import type { RunEventPayload } from '@momonga/protocol';
import type { ContributionPayload } from '@momonga/store';
import { enqueue, harness, mustClaim, mustRun, newSession, rawDb } from './helpers.ts';
import type { Harness } from './helpers.ts';

type Measurement = { runId: string; underWriteLock: boolean };

const contribution: ContributionPayload = { type: 'context.contribution', items: [{ kind: 'memory', id: 'm1', contributed: true }] };

const responded: RunEventPayload = {
  type: 'model.responded',
  step: 1,
  attempt: 1,
  response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
};

const usageUpdated: RunEventPayload = { type: 'usage.updated', inputTokens: 1, outputTokens: 1, totalTokens: 2 };

const measuring = (): { h: Harness; measurements: Measurement[] } => {
  const measurements: Measurement[] = [];
  let probe: (() => boolean) | undefined;
  const h = harness({
    contribution: {
      eventTypes: ['user.message', 'model.responded'],
      measure: ({ run }) => {
        if (probe === undefined) throw new Error('the write-lock probe is not ready');
        measurements.push({ runId: run.id, underWriteLock: probe() });
        return contribution;
      },
    },
  });
  const db = rawDb(h.dbPath);
  db.exec('PRAGMA busy_timeout = 0');
  probe = () => {
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if (error instanceof Error && /locked|busy/i.test(error.message)) return true;
      throw error;
    }
    db.exec('ROLLBACK');
    return false;
  };
  return { h, measurements };
};

describe('a terminal transition led by a model response, for a hook that reads model responses', () => {
  it('measures the run exactly once, and never while the write transaction is open', () => {
    const { h, measurements } = measuring();
    const run = enqueue(h.store, newSession(h.store).id);
    const claim = mustClaim(h.store, 'w1');

    const result = h.store.transition(claim, ['RUNNING'], 'FAILED', { error: { code: 'input_truncated', message: 'truncated' } }, [responded, usageUpdated]);

    expect(result.kind).toBe('ok');
    expect(mustRun(h.store, run.id).status).toBe('FAILED');
    expect(measurements).toEqual([{ runId: run.id, underWriteLock: false }]);
  });
});
