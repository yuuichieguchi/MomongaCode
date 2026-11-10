import { describe, expect, it } from 'vitest';
import { agentReadiness } from '@momonga/protocol';
import type { Readiness } from '@momonga/protocol';
import type { AcpDeps } from '../src/acp/agent.ts';
import { stopReasonOf } from '../src/acp/stop-reason.ts';
import { INITIALIZE, startAgent, updatesOf } from './acp-harness.ts';
import type { Harness } from './acp-harness.ts';
import { SESSION, runView } from './fake-backend.ts';

const UNAVAILABLE_MESSAGE = 'the model plan-model cannot be used yet';

const UNAVAILABLE: Readiness = agentReadiness({
  toolCalling: { state: 'unavailable', status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: UNAVAILABLE_MESSAGE, param: 'model' },
  source: 'unprobed',
});

const noticeTexts = (harness: Harness): string[] =>
  updatesOf(harness.peer.received).flatMap(({ sessionUpdate, content }) =>
    sessionUpdate === 'agent_message_chunk' && typeof content === 'object' && content !== null && 'text' in content && typeof content.text === 'string' ? [content.text] : [],
  );

const detailOf = (message: string): Record<string, unknown> => {
  try {
    stopReasonOf(runView({ id: 'run-1', status: 'FAILED', error: { code: 'target_not_ready', message } }));
  } catch (error) {
    return (error as { data: Record<string, unknown> }).data;
  }
  throw new Error('a failed run gave a stop reason');
};

describe('ACP shows the readiness of a model as a shell surface does', () => {
  it('the notice for an unavailable model is the message, a newline and the remedy that names shell commands', { timeout: 10_000 }, async () => {
    const harness = startAgent({ readinessOf: async () => UNAVAILABLE } as Partial<AcpDeps>);
    await harness.peer.request('initialize', INITIALIZE);

    await harness.peer.request('session/new', { cwd: SESSION.cwd, mcpServers: [] });

    await harness.peer.untilReceived((message) => JSON.stringify(message).includes(UNAVAILABLE_MESSAGE));
    const notice = noticeTexts(harness).find((text) => text.includes(UNAVAILABLE_MESSAGE)) ?? '';
    expect(notice).toContain(`${UNAVAILABLE_MESSAGE}\nChoose a model with momonga --model <model>, or set one up with momonga models add.`);
    await harness.peer.close();
  });

  it('the detail of a run that failed with target_not_ready holds a remedy only when the stored message has a second line', () => {
    expect(detailOf('the model has not been measured\nrun `momonga gateway probe qwen3.8:27b`')).toMatchObject({ code: 'target_not_ready', remedy: 'run `momonga gateway probe qwen3.8:27b`' });
    expect(detailOf(UNAVAILABLE_MESSAGE)).toMatchObject({ code: 'target_not_ready' });
    expect(detailOf(UNAVAILABLE_MESSAGE)).not.toHaveProperty('remedy');
  });
});
