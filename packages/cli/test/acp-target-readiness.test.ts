import { describe, expect, it } from 'vitest';
import { agentReadiness } from '@momonga/protocol';
import type { NeedsProbe, Readiness } from '@momonga/protocol';
import type { AcpDeps } from '../src/acp/agent.ts';
import { SESSION, runView } from './fake-backend.ts';
import { INITIALIZE, OTHER_MODEL, errorOf, resultOf, startAgent, updatesOf } from './acp-harness.ts';
import type { Harness } from './acp-harness.ts';

const NEW_SESSION = { cwd: SESSION.cwd, mcpServers: [] };

const NEEDS_PROBE: NeedsProbe = {
  state: 'needs_probe',
  message: 'target local has not been probed for tool calling',
  evidence: 'no probe record for local',
  remedy: 'run the tool-calling probe for local',
};

const NO_TOOLS_NOTICE = 'This model cannot call tools';

const readinessDeps = (byModel: Readonly<Record<string, Readiness>>): Partial<AcpDeps> =>
  ({ readinessOf: async (model: string) => byModel[model] ?? { state: 'ready' } }) as Partial<AcpDeps>;

const noticeTexts = (harness: Harness): string[] =>
  updatesOf(harness.peer.received).flatMap(({ sessionUpdate, content }) =>
    sessionUpdate === 'agent_message_chunk' && typeof content === 'object' && content !== null && 'text' in content && typeof content.text === 'string' ? [content.text] : [],
  );

const untilNotice = (harness: Harness, fragment: string) =>
  harness.peer.untilReceived((message) => {
    const [update] = updatesOf([message]);
    const content = update?.['content'];
    return update?.sessionUpdate === 'agent_message_chunk' && typeof content === 'object' && content !== null && 'text' in content && String(content.text).includes(fragment);
  });

const NOTICE_BOUND = { timeout: 10_000 };

describe('ACP carries the readiness verdict', () => {
  it('session/new on a model that reports no tool calling sends the no-tools notice, naming momonga --model', NOTICE_BOUND, async () => {
    const harness = startAgent(readinessDeps({ [SESSION.model]: agentReadiness({ toolCalling: 'none' }) }));
    await harness.peer.request('initialize', INITIALIZE);

    const created = resultOf(await harness.peer.request('session/new', NEW_SESSION)) as { sessionId: string };

    expect(created.sessionId).toBe(SESSION.id);
    await untilNotice(harness, NO_TOOLS_NOTICE);
    const notice = noticeTexts(harness).find((text) => text.includes(NO_TOOLS_NOTICE)) ?? '';
    expect(notice).toContain('momonga --model <model>');
    expect(notice).not.toContain('/model');
    expect(notice).not.toMatch(/probe/i);
    await harness.peer.close();
  });

  it('session/new on an unprobed model sends the probe remedy as a notice', NOTICE_BOUND, async () => {
    const harness = startAgent(readinessDeps({ [SESSION.model]: agentReadiness({ toolCalling: NEEDS_PROBE }) }));
    await harness.peer.request('initialize', INITIALIZE);

    await harness.peer.request('session/new', NEW_SESSION);

    await untilNotice(harness, NEEDS_PROBE.remedy);
    await harness.peer.close();
  });

  it('selecting a model that reports no tool calling sends the no-tools notice', NOTICE_BOUND, async () => {
    const other = OTHER_MODEL;
    const harness = startAgent(readinessDeps({ [other]: agentReadiness({ toolCalling: 'none' }) }));
    await harness.peer.request('initialize', INITIALIZE);
    const { sessionId } = resultOf(await harness.peer.request('session/new', NEW_SESSION)) as { sessionId: string };

    await harness.peer.request('session/set_config_option', { sessionId, configId: 'model', value: other });

    await untilNotice(harness, NO_TOOLS_NOTICE);
    await harness.peer.close();
  });

  it('a first prompt on an unprobed model fails with target_not_ready and the remedy on its own line', async () => {
    const harness = startAgent(readinessDeps({ [SESSION.model]: agentReadiness({ toolCalling: NEEDS_PROBE }) }));
    await harness.peer.request('initialize', INITIALIZE);
    const { sessionId } = resultOf(await harness.peer.request('session/new', NEW_SESSION)) as { sessionId: string };
    harness.scripts.set('run-1', async () =>
      runView({ id: 'run-1', status: 'FAILED', error: { code: 'target_not_ready', message: `${NEEDS_PROBE.message}\n${NEEDS_PROBE.remedy}` } }),
    );

    const failure = errorOf(await harness.peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'go' }] }));

    expect(failure.data).toMatchObject({ code: 'target_not_ready', remedy: NEEDS_PROBE.remedy });
    expect(JSON.stringify(failure)).not.toContain('\\\\u000a');
    await harness.peer.close();
  });
});

const UNAVAILABLE_MESSAGE =
  'the model plan-model cannot be used yet: the settings give no context window and output limit for it, and the model list of its account reports none; momonga models --catalog reads the list';
const UNAVAILABLE_REMEDY = 'Choose a model with momonga --model <model>, or set one up with momonga models add.';
const UNAVAILABLE: Parameters<typeof agentReadiness>[0] = {
  toolCalling: { state: 'unavailable', status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: UNAVAILABLE_MESSAGE, param: 'model' },
  source: 'unprobed',
};

describe('ACP carries the reason of a model the gateway lists as unavailable (G1)', () => {
  it('an unavailable model gets the warning notice M then R', NOTICE_BOUND, async () => {
    const harness = startAgent(readinessDeps({ [SESSION.model]: agentReadiness(UNAVAILABLE) }));
    await harness.peer.request('initialize', INITIALIZE);

    await harness.peer.request('session/new', NEW_SESSION);

    await untilNotice(harness, UNAVAILABLE_MESSAGE);
    const notice = noticeTexts(harness).find((text) => text.includes(UNAVAILABLE_MESSAGE)) ?? '';
    expect(notice).toContain(`${UNAVAILABLE_MESSAGE}\n${UNAVAILABLE_REMEDY}`);
    await harness.peer.close();
  });
});
