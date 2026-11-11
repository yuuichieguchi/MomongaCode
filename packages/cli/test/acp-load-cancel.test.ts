import { describe, expect, it } from 'vitest';
import { SESSION, runView } from './fake-backend.ts';
import { INITIALIZE, errorOf, frameOf, resultOf, startAgent } from './acp-harness.ts';
import type { Harness } from './acp-harness.ts';

const LOAD = { sessionId: SESSION.id, cwd: SESSION.cwd, mcpServers: [] };

const liveUntilCancelled = (harness: Harness, runId: string, lastSeq: number): void => {
  harness.scripts.set(runId, async ({ onEvent }) => {
    onEvent(frameOf(runId, lastSeq, { type: 'run.status', from: 'QUEUED', to: 'RUNNING' }));
    await harness.runtime.called(`cancel ${runId}`);
    return runView({ id: runId, status: 'CANCELLED' });
  });
};

describe('a session loaded while one of its runs is live', () => {
  it('cancels the live run on session/cancel, as a prompt of this connection would be cancelled', async () => {
    const harness = startAgent();
    harness.runtime.runs = [runView({ id: 'run-1', status: 'RUNNING', lastSeq: 1 })];
    liveUntilCancelled(harness, 'run-1', 1);
    await harness.peer.request('initialize', INITIALIZE);
    await harness.peer.request('session/load', LOAD);

    await harness.peer.notify('session/cancel', { sessionId: SESSION.id });
    await harness.peer.request('session/set_mode', { sessionId: SESSION.id, modeId: 'plan' });

    expect(harness.runtime.calls).toContain('cancel run-1');
    await harness.peer.close();
  });

  it('refuses a prompt while the live run goes on, and takes one when it has ended', async () => {
    const harness = startAgent();
    harness.runtime.runs = [runView({ id: 'run-1', status: 'RUNNING', lastSeq: 1 })];
    liveUntilCancelled(harness, 'run-1', 1);
    harness.scripts.set('run-2', async () => runView({ id: 'run-2', status: 'COMPLETED' }));
    harness.runtime.createRunResult = async () => runView({ id: 'run-2', status: 'QUEUED' });
    await harness.peer.request('initialize', INITIALIZE);
    await harness.peer.request('session/load', LOAD);

    const refused = errorOf(await harness.peer.request('session/prompt', { sessionId: SESSION.id, prompt: [{ type: 'text', text: 'next' }] }));
    expect(refused.message).toContain('already working');

    expect(harness.bridge.quiet()).toBe(false);
    await harness.peer.notify('session/cancel', { sessionId: SESSION.id });
    await harness.runtime.called('cancel run-1');
    await harness.peer.request('session/set_mode', { sessionId: SESSION.id, modeId: 'plan' });
    expect(harness.bridge.quiet()).toBe(true);

    expect(resultOf(await harness.peer.request('session/prompt', { sessionId: SESSION.id, prompt: [{ type: 'text', text: 'next' }] }))).toEqual({ stopReason: 'end_turn' });
    await harness.peer.close();
  });

  it('holds no turn for a run that had ended before the load', async () => {
    const harness = startAgent();
    harness.runtime.runs = [runView({ id: 'run-1', status: 'COMPLETED', lastSeq: 0 })];
    harness.scripts.set('run-1', async () => runView({ id: 'run-1', status: 'COMPLETED' }));
    await harness.peer.request('initialize', INITIALIZE);
    await harness.peer.request('session/load', LOAD);

    await harness.peer.notify('session/cancel', { sessionId: SESSION.id });
    await harness.peer.request('session/set_mode', { sessionId: SESSION.id, modeId: 'plan' });

    expect(harness.runtime.calls.filter((call) => call.startsWith('cancel'))).toEqual([]);
    await harness.peer.close();
  });
});

describe('a session adopted from a handover while one of its runs is live', () => {
  it('cancels the live run on session/cancel', async () => {
    const harness = startAgent({}, INITIALIZE);
    harness.runtime.runs = [runView({ id: 'run-1', status: 'RUNNING', lastSeq: 1 })];
    liveUntilCancelled(harness, 'run-1', 1);
    await harness.bridge.adopt({ sessions: [SESSION.id], lastSeq: { 'run-1': 0 } });

    await harness.peer.notify('session/cancel', { sessionId: SESSION.id });
    await harness.peer.request('session/set_mode', { sessionId: SESSION.id, modeId: 'plan' });

    expect(harness.runtime.calls).toContain('cancel run-1');
    await harness.peer.close();
  });
});
