import { describe, expect, it, vi } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS, DAEMON_PROCESS_TEST_TIMEOUT_MS, fakeUsageOfRequest } from '@momonga/testkit';
import { launchRuntime, prepareStack, startGateway, waitForStatus } from './run-helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PROCESS_TIMEOUT = { timeout: DAEMON_PROCESS_TEST_TIMEOUT_MS };

const finalEnvelope = {
  kind: 'stream' as const,
  chunks: [{ delta: { role: 'assistant', content: '{"kind":"final","text":"Done."}' }, finishReason: 'stop' }],
  usage: (body: unknown) => fakeUsageOfRequest(body, 5),
};

const constrainedModels = (socketPath: string, contextWindow: number) => ({
  models: {
    aliases: { default: ['primary'] },
    targets: {
      primary: {
        adapter: 'chat-completions',
        provider: 'fake',
        model: 'system',
        socketPath,
        toolCalling: 'constrained',
        capabilities: { contextWindow, maxOutputTokens: 1024, structuredOutput: 'json_schema' },
      },
    },
  },
});

const CONTEXT_WINDOW = 8192;

describe('a constrained target whose server leaves response_format out of prompt_tokens, as LM Studio does', () => {
  it('completes a one-step run instead of failing it as input_truncated', PROCESS_TIMEOUT, async () => {
    const stack = await prepareStack({ scenario: 'json-schema-only', contextWindow: CONTEXT_WINDOW, script: [finalEnvelope] });
    stack.settings(constrainedModels(stack.fake.socketPath, CONTEXT_WINDOW));
    await startGateway(stack.temp);
    const launched = await launchRuntime(stack.temp);
    const session = await launched.createSession();
    const run = await launched.createRun(session.id, { input: 'Say hello' });
    const status = await waitForStatus(stack.temp, run.id, ['COMPLETED', 'FAILED']);
    const view = (await launched.http('GET', `/v1/runs/${run.id}`)).json.run;
    expect(view.error).toBeUndefined();
    expect(status).toBe('COMPLETED');
  });
});
