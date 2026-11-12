import { describe, expect, it } from 'vitest';
import type { ElicitationRequestView, RunEvent, RunEventPayload } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { FIXTURE_RUN_ID, FIXTURE_SESSION_ID, materializeEvents } from '@momonga/testkit';
import { TEST_FENCE } from '@momonga/testkit';

const REQUESTS: ElicitationRequestView[] = [{ key: 'who', mode: 'url', message: 'Connect', url: 'https://example.test/c' }];

const foldAll = (events: readonly RunEvent[]) => events.reduce(foldRunState, initialRunState({ runId: FIXTURE_RUN_ID, sessionId: FIXTURE_SESSION_ID, fence: TEST_FENCE }));

const started: RunEventPayload[] = [
  { type: 'user.message', text: 'go' },
  { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'mcp__remote__t', kind: 'other', title: 't', rawInput: {} },
  { type: 'tool.started', callId: 'c1', idemKey: 'k' },
];
const asked: RunEventPayload = { type: 'tool.elicitation.requested', inputId: 'i1', callId: 'c1', server: 'remote', requests: REQUESTS };

describe('tool.elicitation fold', () => {
  it('parks the started call as awaiting_input with the request', () => {
    expect(foldAll(materializeEvents([...started, asked])).pendingCalls['c1']).toMatchObject({
      status: 'awaiting_input',
      idemKey: 'k',
      input: { inputId: 'i1', server: 'remote', requests: REQUESTS },
    });
  });

  it('turns an answer into a started call that carries the answers and no pending request', () => {
    const responses = { who: { action: 'accept' as const } };
    const call = foldAll(materializeEvents([...started, asked, { type: 'tool.elicitation.resolved', inputId: 'i1', responses }])).pendingCalls['c1'];
    expect(call).toMatchObject({ status: 'started', inputResolution: { inputId: 'i1', responses } });
    expect(call).not.toHaveProperty('input');
  });

  it('drops stale answers when the same call asks again', () => {
    const second: RunEventPayload = { ...asked, inputId: 'i2' } as RunEventPayload;
    const call = foldAll(
      materializeEvents([...started, asked, { type: 'tool.elicitation.resolved', inputId: 'i1', responses: { who: { action: 'decline' } } }, second]),
    ).pendingCalls['c1'];
    expect(call).toMatchObject({ status: 'awaiting_input', input: { inputId: 'i2' } });
    expect(call).not.toHaveProperty('inputResolution');
  });

  it('returns a withdrawn request to started', () => {
    const call = foldAll(materializeEvents([...started, asked, { type: 'tool.elicitation.cancelled', inputId: 'i1', reason: 'withdrawn' }])).pendingCalls['c1'];
    expect(call).toMatchObject({ status: 'started' });
    expect(call).not.toHaveProperty('input');
  });

  it('refuses an answer for a request the run never made', () => {
    expect(() => foldAll(materializeEvents([...started, { type: 'tool.elicitation.resolved', inputId: 'nope', responses: {} }]))).toThrow(/unknown elicitation nope/);
  });

  it('ignores an authorization notice', () => {
    const folded = foldAll(materializeEvents([...started, { type: 'mcp.authorization.required', callId: 'c1', server: 'remote' }, asked]));
    expect(folded.pendingCalls['c1']?.status).toBe('awaiting_input');
  });
});
