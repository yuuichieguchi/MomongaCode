import { describe, expect, it } from 'vitest';
import type { ContributionPayload } from '@momonga/store';
import { awaitingInput } from './approval-fixture.ts';
import { START_MS, harness, mustRun, rawDb } from './helpers.ts';
import type { Harness } from './helpers.ts';

type Measurement = { runId: string; underWriteLock: boolean };

const contribution: ContributionPayload = { type: 'context.contribution', items: [{ kind: 'memory', id: 'm1', contributed: true }] };

const FIRST_DUE_MS = START_MS + 1000;
const SECOND_DUE_MS = START_MS + 2000;

const measuring = (): { h: Harness; measurements: Measurement[] } => {
  const measurements: Measurement[] = [];
  let probe: (() => boolean) | undefined;
  let advanceOnMeasure: (() => void) | undefined;
  const h = harness({
    contribution: {
      eventTypes: ['user.message'],
      measure: ({ run }) => {
        if (probe === undefined || advanceOnMeasure === undefined) throw new Error('the test probes are not ready');
        measurements.push({ runId: run.id, underWriteLock: probe() });
        advanceOnMeasure();
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
  advanceOnMeasure = () => h.clock.set(SECOND_DUE_MS + 1);
  return { h, measurements };
};

describe('an answer for input that arrives after one of two requests for input is due, while the clock moves past the other', () => {
  it('measures the run once, outside the write transaction, on the time the operation read once', async () => {
    const { h, measurements } = measuring();
    const waiting = awaitingInput(h.store, [{ callId: 'a', expiresAt: FIRST_DUE_MS }, { callId: 'b', expiresAt: SECOND_DUE_MS }], 'waiting');
    const [first] = waiting.approvals;
    if (first === undefined) throw new Error('expected the first request for input');
    h.clock.set(FIRST_DUE_MS + 1);

    expect((await h.store.resolveElicitation(first.id, {}))).toMatchObject({ kind: 'approval_not_pending', status: 'expired' });

    expect(mustRun(h.store, waiting.runId).status).toBe('STOPPED');
    expect(measurements).toEqual([{ runId: waiting.runId, underWriteLock: false }]);
  });
});
