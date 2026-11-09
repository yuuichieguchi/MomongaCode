import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_COMPLETIONS_VOCABULARY, runProbe } from '@momonga/gateway';
import { countFakeRequestTokens, startFakeChatCompletions, type FakeChatCompletionsServer } from '@momonga/testkit';
import { FM_PROBE_ROUTES } from './fm-record-support.ts';

const LMSTUDIO_OVERFLOW_TEXT =
  'The number of tokens to keep from the initial prompt is greater than the context length. Try to load the model with a larger context length, or provide a shorter input';

const LMSTUDIO_OVERFLOW = { status: 400, body: { error: LMSTUDIO_OVERFLOW_TEXT } };

const LMSTUDIO_STREAMED_OVERFLOW = { status: 200, body: { error: { message: LMSTUDIO_OVERFLOW_TEXT }, message: LMSTUDIO_OVERFLOW_TEXT } };

const LMSTUDIO_RESPONSE_FORMAT_UNSUPPORTED = { status: 400, body: { error: "'response_format.type' must be 'json_schema' or 'text'" } };

const LMSTUDIO_IMAGE_UNSUPPORTED = {
  status: 400,
  body: {
    error: {
      message: 'The provided messages contain images, but qwen2.5-coder-1.5b-instruct-mlx does not support image inputs.',
      type: 'invalid_request_error',
      param: 'messages',
      code: 'invalid_value',
    },
  },
};

describe("CHAT_COMPLETIONS_VOCABULARY reads LM Studio's error bodies, whose error is a string or an object", () => {
  it('classifies the overflow that LM Studio answers with a string error and HTTP 400 as context_overflow', () => {
    expect(CHAT_COMPLETIONS_VOCABULARY.kindOf(LMSTUDIO_OVERFLOW.status, LMSTUDIO_OVERFLOW.body)).toBe('context_overflow');
  });

  it('classifies the same overflow streamed as an error event with an object error as context_overflow', () => {
    expect(CHAT_COMPLETIONS_VOCABULARY.kindOf(LMSTUDIO_STREAMED_OVERFLOW.status, LMSTUDIO_STREAMED_OVERFLOW.body)).toBe('context_overflow');
  });

  it('classifies the rejected response_format, a string error, as unsupported', () => {
    expect(CHAT_COMPLETIONS_VOCABULARY.kindOf(LMSTUDIO_RESPONSE_FORMAT_UNSUPPORTED.status, LMSTUDIO_RESPONSE_FORMAT_UNSUPPORTED.body)).toBe('unsupported');
  });

  it('classifies the rejected image input, an object error, as unsupported', () => {
    expect(CHAT_COMPLETIONS_VOCABULARY.kindOf(LMSTUDIO_IMAGE_UNSUPPORTED.status, LMSTUDIO_IMAGE_UNSUPPORTED.body)).toBe('unsupported');
  });
});

describe('the probe of an LM Studio server', () => {
  const servers: FakeChatCompletionsServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("searches the context window through LM Studio's string-error overflow and records that body", async () => {
    const window = 3000;
    const requestedTokens = (body: unknown): number => {
      const maxTokens = (body as { max_tokens?: unknown }).max_tokens;
      return countFakeRequestTokens(body) + (typeof maxTokens === 'number' ? maxTokens : 0);
    };
    const fake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      contextWindow: window,
      contextSizeExposure: 'none',
      routes: [{ match: (body) => requestedTokens(body) > window, reply: { kind: 'error', ...LMSTUDIO_OVERFLOW } }],
    });
    servers.push(fake);

    const report = await runProbe({ socketPath: fake.socketPath, managed: FM_PROBE_ROUTES, samples: 2 });

    expect(report.contextWindow.method).toBe('searched');
    expect(Math.abs(report.contextWindow.value - window)).toBeLessThanOrEqual(window * 0.02);
    expect(report.contextWindow.overflowErrorShape).toEqual(LMSTUDIO_OVERFLOW.body);
  });
});
