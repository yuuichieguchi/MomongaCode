import { afterEach, describe, expect, it } from 'vitest';
import { FM_VOCABULARY, runProbe } from '@momonga/gateway';
import { startFakeChatCompletions, type FakeChatCompletionsServer, type FakeStreamChunk } from '@momonga/testkit';

const LONG_ANSWER_PROMPT = 'Count from 1 to 300, one number per line, and write nothing else.';

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

type ChatBody = { messages?: Array<{ content?: unknown }> };

const asksForALongAnswer = (body: unknown): boolean => (body as ChatBody).messages?.[0]?.content === LONG_ANSWER_PROMPT;

const FM_BOUNDED_COUNT: FakeStreamChunk[] = [
  { delta: { role: 'assistant' } },
  { delta: { content: '1  ' } },
  { delta: { content: '\n' } },
  { delta: { content: '2  ' } },
  { delta: { content: '\n3' } },
  { delta: { content: '  \n4' } },
  { delta: { content: '  \n' } },
  { delta: { content: '5' } },
  { delta: { content: '  ' } },
  { delta: { content: '\n6' } },
  { delta: {}, finishReason: 'stop' },
];

describe('the fm probe reads a streamed reply through the decoder every probe step shares', () => {
  it('measures the output bound when fm answers with an event stream that carries no usage', async () => {
    const fake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      wire: 'fm',
      contextWindow: 4096,
      contextSizeExposure: 'none',
      routes: [{ match: asksForALongAnswer, reply: { kind: 'stream', chunks: FM_BOUNDED_COUNT } }],
    });
    servers.push(fake);

    const report = await runProbe({ schemaDialect: 'guided-generation', socketPath: fake.socketPath, managedHealthRoute: true, samples: 2, vocabulary: FM_VOCABULARY });

    expect(fake.routeHits[0]).toBeGreaterThan(0);
    expect(report.outputBoundField).toBe('max_completion_tokens');
  });

  it('reads the tool calls and the content of every streamed sample as it reads them from a JSON reply, and reports the usage fm never streams as absent', async () => {
    const options = { scenario: 'tools-ok', contextWindow: 4096, contextSizeExposure: 'none' } as const;
    const streamed = await startFakeChatCompletions({ ...options, wire: 'fm' });
    const unary = await startFakeChatCompletions(options);
    servers.push(streamed, unary);

    const fromStream = await runProbe({ schemaDialect: 'guided-generation', socketPath: streamed.socketPath, managedHealthRoute: true, samples: 2, vocabulary: FM_VOCABULARY });
    const fromJson = await runProbe({ schemaDialect: 'guided-generation', socketPath: unary.socketPath, managedHealthRoute: true, samples: 2 });

    expect(fromStream.constrained).toEqual(fromJson.constrained);
    expect(fromStream.nativeTools).toEqual({ accepted: true, validRate: 0, roundTripOk: false });
    expect(fromJson.nativeTools).toEqual({ accepted: true, validRate: 1, roundTripOk: true });
    expect(fromStream.usageReported).toBe(false);
    expect(fromJson.usageReported).toBe(true);
  });
});
