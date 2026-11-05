import { afterEach, describe, expect, it } from 'vitest';
import { FM_VOCABULARY, runProbe } from '@momonga/gateway';
import { FM_CONTEXT_OVERFLOW_ERROR, countFakeRequestTokens, startFakeChatCompletions, type FakeChatCompletionsServer } from '@momonga/testkit';
import { TARGET, collect, lastCompletionBody, makeAdapter, startFake, userText } from './cc-support.ts';

const FM_WINDOW = 4096;

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

type ChatBody = { messages?: Array<{ role?: unknown; content?: unknown }>; max_completion_tokens?: unknown };

const isConstrainedSample = (body: unknown): boolean => {
  const messages = (body as ChatBody).messages ?? [];
  return messages[0]?.role === 'system' && messages[0]?.content === 'Answer only with JSON that matches the given schema.';
};

const carriesAnOutputBoundFmHonours = (body: unknown): boolean => typeof (body as ChatBody).max_completion_tokens === 'number';

const generatesUntilTheWindowFills = (body: unknown): boolean => isConstrainedSample(body) && !carriesAnOutputBoundFmHonours(body);

const startFakeFm = async (): Promise<FakeChatCompletionsServer> => {
  const fake = await startFakeChatCompletions({
    scenario: 'tools-ok',
    wire: 'fm',
    contextWindow: FM_WINDOW,
    contextSizeExposure: 'none',
    routes: [{ match: generatesUntilTheWindowFills, reply: { kind: 'error-event', body: FM_CONTEXT_OVERFLOW_ERROR } }],
  });
  servers.push(fake);
  return fake;
};

describe('the fm probe bounds what the model generates by the window it measures', () => {
  it('finishes when an unbounded constrained sample would generate until fm reports the transcript over its context size', async () => {
    const fake = await startFakeFm();

    const report = await runProbe({ socketPath: fake.socketPath, managedHealthRoute: true, samples: 2, vocabulary: FM_VOCABULARY });

    expect(report.constrained.accepted).toBe(true);
    expect(fake.routeHits).toEqual([0]);
  });

  it('sends every request whose prompt fits the window with an output bound fm honours, and prompt plus bound within the window it reports', async () => {
    const fake = await startFakeFm();

    const report = await runProbe({ socketPath: fake.socketPath, managedHealthRoute: true, samples: 2, vocabulary: FM_VOCABULARY }).catch(() => undefined);

    const window = report?.contextWindow.value ?? FM_WINDOW;
    const fitting = fake.requests
      .filter((request) => request.path === '/v1/chat/completions')
      .map((request) => request.body)
      .filter((body) => countFakeRequestTokens(body) < window);
    expect(fitting.length).toBeGreaterThan(0);
    const unbounded = fitting.filter((body) => !carriesAnOutputBoundFmHonours(body)).map((body) => JSON.stringify(body).slice(0, 120));
    expect(unbounded).toEqual([]);
    const overWindow = fitting.filter((body) => countFakeRequestTokens(body) + ((body as ChatBody).max_completion_tokens as number) > window);
    expect(overWindow).toEqual([]);
  });
});

describe('a run against fm bounds what the model generates', () => {
  it('sends the output bound of a run in the field fm honours', async () => {
    const fake = await startFake({ scenario: 'tools-ok', wire: 'fm' });
    const adapter = makeAdapter(fake, { vocabulary: FM_VOCABULARY });

    const { error } = await collect(adapter, { model: TARGET.model, input: [userText('hello fm')], max_output_tokens: 300 });

    expect(error).toBeUndefined();
    expect(lastCompletionBody(fake).max_completion_tokens).toBe(300);
  });
});
