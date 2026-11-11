import { describe, expect, it } from 'vitest';
import { foldRunState, initialRunState } from '@momonga/store';
import { callEvent, enqueue, harness, mustClaim, newSession } from './helpers.ts';
import { roundTripped } from './run-state-codec.ts';

describe('tool.waiting', () => {
  it('records what a call awaits without changing its status, and ignores job.finished', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    const claim = mustClaim(store, 'w1');
    store.append(claim, [
      callEvent('c1'),
      { type: 'tool.started', callId: 'c1', idemKey: 'k1' },
      { type: 'tool.waiting', callId: 'c1', awaits: { kind: 'run', runId: 'child', sessionId: 's', agent: 'helper' } },
      { type: 'job.finished', jobId: 'bash_x', status: 'exited', exitCode: 0 },
    ]);
    const state = store.readRunEvents(run.id, 0, 100).reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }));
    expect(state.pendingCalls['c1']).toMatchObject({ status: 'started', awaiting: { kind: 'run', runId: 'child', agent: 'helper' } });
  });

  it('survives a snapshot round trip', async () => {
    const { store } = harness();
    const run = await enqueue(store, newSession(store).id);
    store.append(mustClaim(store, 'w1'), [callEvent('c1'), { type: 'tool.waiting', callId: 'c1', awaits: { kind: 'job', jobId: 'bash_x' } }]);
    const state = store.readRunEvents(run.id, 0, 100).reduce(foldRunState, initialRunState({ runId: run.id, sessionId: run.sessionId }));
    expect(roundTripped(state)?.pendingCalls['c1']?.awaiting).toEqual({ kind: 'job', jobId: 'bash_x' });
  });
});
