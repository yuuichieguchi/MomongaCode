import { afterEach, describe, expect, it, vi } from 'vitest';
import { FM_VOCABULARY, capabilitiesFromProbe, ProbeTimeoutError, runProbe } from '@momonga/gateway';
import { Deadline } from '@momonga/foundation';
import { tokensForText } from '@momonga/protocol';
import type { ProbeReport } from '@momonga/protocol';
import {
  FAKE_GUARDRAIL_ERROR,
  FAKE_PAYLOAD_TOO_LARGE_ERROR,
  FM_CONTEXT_OVERFLOW_ERROR,
  FM_GUARDRAIL_ERROR,
  FM_UNSUPPORTED_GUIDE_ERROR,
  countFakeRequestTokens,
  countFakeTokens,
  startFakeChatCompletions,
  type FakeChatCompletionsOptions,
  type FakeChatCompletionsServer,
} from '@momonga/testkit';
import { fillerText } from '../src/probe/filler.ts';
import { isProbeReport } from '../src/probe/report-schema.ts';

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const CACHE_PROBE_WORDS = 1536;

const fixedNow = () => new Date('2026-10-23T12:00:00.000Z');

const probe = async (
  options: FakeChatCompletionsOptions,
  probeOptions: Omit<Parameters<typeof runProbe>[0], 'socketPath' | 'schemaDialect'> = {},
): Promise<{ report: ProbeReport; fake: FakeChatCompletionsServer }> => {
  const fake = await startFakeChatCompletions(options);
  servers.push(fake);
  const report = await runProbe({ schemaDialect: options.wire === 'fm' ? 'guided-generation' : 'json-schema-2020-12', socketPath: fake.socketPath, managedHealthRoute: true, now: fixedNow, ...probeOptions });
  return { report, fake };
};

const SLOW_MS = 150;
const IMAGE_WRAPPER_TOKENS = tokensForText(`,${JSON.stringify({ type: 'image_url' })}`);
const WINDOW_HOLDING_THE_LARGEST_IMAGE = 200_000;

const words = (text: string): number => text.split(/\s+/).filter((word) => word.length > 0).length;

describe('runProbe basics', () => {
  it('reports health, model id, probedAt and never sends json_object', async () => {
    const { report, fake } = await probe({ scenario: 'tools-ok', modelId: 'apple-fm' });
    expect(report.health).toEqual({ ok: true });
    expect(report.modelId).toBe('apple-fm');
    expect(report.probedAt).toBe('2026-10-23T12:00:00.000Z');
    const formats = fake.requests.map((request) => (request.body as { response_format?: { type?: string } } | undefined)?.response_format?.type);
    expect(formats).not.toContain('json_object');
  });

  it('uses the given model in chat requests', async () => {
    const { fake } = await probe({ scenario: 'tools-ok' }, { model: 'custom-model' });
    const chatBodies = fake.requests.filter((request) => request.path === '/v1/chat/completions').map((request) => request.body as { model?: string });
    expect(chatBodies.length).toBeGreaterThan(0);
    expect(chatBodies.every((body) => body.model === 'custom-model')).toBe(true);
  });
});

describe('runProbe tool calling', () => {
  it('tools-ok with full validity: native accepted, valid rate 1, round trip ok', async () => {
    const { report } = await probe({ scenario: 'tools-ok', nativeValidity: 1 });
    expect(report.nativeTools).toEqual({ accepted: true, validRate: 1, roundTripOk: true });
    expect(report.constrained).toEqual({ accepted: true, validRate: 1 });
  });

  it('tools-ok with native validity 0.7 measures 0.7 over 10 samples', async () => {
    const { report } = await probe({ scenario: 'tools-ok', nativeValidity: 0.7 });
    expect(report.nativeTools.accepted).toBe(true);
    expect(report.nativeTools.validRate).toBeCloseTo(0.7, 10);
  });

  it('honours the samples option', async () => {
    const { report, fake } = await probe({ scenario: 'tools-ok', nativeValidity: 0.5, constrainedValidity: 0.5 }, { samples: 4 });
    expect(report.nativeTools.validRate).toBeCloseTo(0.5, 10);
    expect(report.constrained.validRate).toBeCloseTo(0.5, 10);
    const toolSamples = fake.requests.filter((request) => {
      const body = request.body as { tools?: unknown[]; messages?: Array<{ role?: string }> } | undefined;
      return Array.isArray(body?.tools) && body?.messages?.at(-1)?.role === 'user';
    });
    expect(toolSamples.length).toBeGreaterThanOrEqual(4);
  });

  it('tools-400: native not accepted, valid rate 0, constrained measured', async () => {
    const { report } = await probe({ scenario: 'tools-400', constrainedValidity: 0.9 });
    expect(report.nativeTools).toEqual({ accepted: false, validRate: 0, roundTripOk: false });
    expect(report.constrained.accepted).toBe(true);
    expect(report.constrained.validRate).toBeCloseTo(0.9, 10);
  });

  it('tools-ignored: native accepted but valid rate 0', async () => {
    const { report } = await probe({ scenario: 'tools-ignored' });
    expect(report.nativeTools.accepted).toBe(true);
    expect(report.nativeTools.validRate).toBe(0);
    expect(report.constrained).toEqual({ accepted: true, validRate: 1 });
  });

  it('json-schema-only: native not accepted, constrained valid', async () => {
    const { report } = await probe({ scenario: 'json-schema-only', constrainedValidity: 0.5 });
    expect(report.nativeTools.accepted).toBe(false);
    expect(report.nativeTools.validRate).toBe(0);
    expect(report.constrained.accepted).toBe(true);
    expect(report.constrained.validRate).toBeCloseTo(0.5, 10);
  });

  it('none: neither native nor constrained accepted', async () => {
    const { report } = await probe({ scenario: 'none' });
    expect(report.nativeTools).toEqual({ accepted: false, validRate: 0, roundTripOk: false });
    expect(report.constrained).toEqual({ accepted: false, validRate: 0 });
  });
});

describe('runProbe context window', () => {
  it('reads context_window from /v1/models', async () => {
    const { report } = await probe({ scenario: 'tools-ok', contextWindow: 8192, contextSizeExposure: 'models' });
    expect(report.contextWindow).toEqual({ value: 8192, method: 'reported' });
  });

  it('reads context_window from /health', async () => {
    const { report } = await probe({ scenario: 'tools-ok', contextWindow: 6000, contextSizeExposure: 'health' });
    expect(report.contextWindow).toEqual({ value: 6000, method: 'reported' });
  });

  it('searches the context window within 2% when it is not exposed', async () => {
    const { report } = await probe({ scenario: 'tools-ok', contextWindow: 3000, contextSizeExposure: 'none' });
    expect(report.contextWindow.method).toBe('searched');
    expect(Math.abs(report.contextWindow.value - 3000)).toBeLessThanOrEqual(60);
  });

  it('reads an overflow that fm reports as an error event in a 200 stream as a rejection through fm\'s vocabulary, and stops doubling at the first one', async () => {
    const window = 3000;
    const searchPrompt = (count: number) => ({ messages: [{ role: 'user', content: fillerText(count) }] });
    let firstRejectedSize = 64;
    while (countFakeRequestTokens(searchPrompt(firstRejectedSize)) + 1 <= window) firstRejectedSize *= 2;

    const { report, fake } = await probe({ scenario: 'tools-ok', contextWindow: window, contextSizeExposure: 'none', wire: 'fm' }, { vocabulary: FM_VOCABULARY, countTokens: async (text) => countFakeTokens(text) });

    const searchSizes = fake.requests
      .filter((request) => request.path === '/v1/chat/completions' && (request.body as { max_completion_tokens?: unknown }).max_completion_tokens === 1)
      .map((request) => (request.body as { messages?: Array<{ content?: unknown }> }).messages?.[0]?.content)
      .filter((content): content is string => typeof content === 'string' && content === fillerText(words(content)) && words(content) !== CACHE_PROBE_WORDS)
      .map(words);
    expect(report.contextWindow.method).toBe('searched');
    expect(Math.abs(report.contextWindow.value - window)).toBeLessThanOrEqual(window * 0.02);
    expect(report.contextWindow.overflowErrorShape).toEqual(FM_CONTEXT_OVERFLOW_ERROR);
    expect(Math.max(...searchSizes)).toBe(firstRejectedSize);
    expect(searchSizes).not.toContain(262144);
  });
});

describe('runProbe server features', () => {
  it('detects missing stop sequence support by default', async () => {
    const { report } = await probe({ scenario: 'tools-ok' });
    expect(report.stopSequences).toBe(false);
  });

  it('detects stop sequence support', async () => {
    const { report } = await probe({ scenario: 'tools-ok', stopSupported: true });
    expect(report.stopSequences).toBe(true);
  });

  it('detects whether an image part is accepted', async () => {
    expect((await probe({ scenario: 'tools-ok' })).report.imageInputAccepted).toBe(false);
    expect((await probe({ scenario: 'tools-ok', imageInput: true })).report.imageInputAccepted).toBe(true);
  });

  it('measures the image token model of a target that accepts images and reports usage', async () => {
    const { report } = await probe({ scenario: 'tools-ok', imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600 } });
    expect(report.imageInputAccepted).toBe(true);
    expect(report.imageTokens?.maxTokens).toBe(1600 + IMAGE_WRAPPER_TOKENS);
    expect(report.imageTokens?.minTokens).toBe(1 + IMAGE_WRAPPER_TOKENS);
    expect(report.imageTokens?.pixelsPerToken).toBeGreaterThan(730);
    expect(report.imageTokens?.pixelsPerToken).toBeLessThan(760);
  });

  it('models an endpoint that caps no image within the probe range, with the measured cost of the largest image as a floor for the cap', async () => {
    const { report } = await probe({
      scenario: 'tools-ok',
      imageInput: true,
      imageTokens: { pixelsPerToken: 750, maxTokens: 100_000 },
      contextWindow: WINDOW_HOLDING_THE_LARGEST_IMAGE,
      contextSizeExposure: 'models',
    });
    expect(report.imageInputAccepted).toBe(true);
    expect(report.imageTokens?.pixelsPerToken).toBeGreaterThan(730);
    expect(report.imageTokens?.pixelsPerToken).toBeLessThan(760);
    expect(report.imageTokens?.maxTokens).toBeGreaterThanOrEqual(5593);
    expect(report.imageTokens?.maxTokens).toBeLessThanOrEqual(100_000);
    expect(isProbeReport(report)).toBe(true);
    expect(capabilitiesFromProbe(report, { mode: 'native' }).imageInput).toBe(true);
  });

  it('keeps doubling past 2048 px while the cost still grows, so a linear endpoint is not recorded with the cost of 2048 px as its cap', async () => {
    const { report } = await probe({
      scenario: 'tools-ok',
      imageInput: true,
      imageTokens: { pixelsPerToken: 750, maxTokens: 100_000 },
      contextWindow: WINDOW_HOLDING_THE_LARGEST_IMAGE,
      contextSizeExposure: 'models',
    });
    expect(report.imageTokens?.maxTokens).toBeGreaterThanOrEqual(Math.ceil(8192 ** 2 / 750));
  });

  it('stops doubling once the cost has plateaued and reports the plateau as the cap', async () => {
    const { fake } = await probe({ scenario: 'tools-ok', imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600 } });
    const sides = fake.requests.flatMap((request) => {
      const content = (request.body as { messages?: { content?: unknown }[] } | undefined)?.messages?.[0]?.content;
      if (!Array.isArray(content)) return [];
      const image = content.find((part: unknown) => typeof part === 'object' && part !== null && 'image_url' in part) as { image_url: { url: string } } | undefined;
      if (image === undefined) return [];
      return [Buffer.from(image.image_url.url.split(',')[1]?.slice(0, 64) ?? '', 'base64').readUInt32BE(16)];
    });
    expect(Math.max(...sides)).toBe(4096);
  });

  it('takes pixelsPerToken from a size below the plateau when the cap is reached below the 512 px reference', async () => {
    const { report } = await probe({ scenario: 'tools-ok', imageInput: true, imageTokens: { pixelsPerToken: 328, maxTokens: 200 } });
    expect(report.imageTokens?.maxTokens).toBe(200 + IMAGE_WRAPPER_TOKENS);
    expect(report.imageTokens?.pixelsPerToken).toBeGreaterThan(285);
    expect(report.imageTokens?.pixelsPerToken).toBeLessThan(336);
  });

  it('reports no image token model when every size below the plateau costs the floor', async () => {
    const { report } = await probe({ scenario: 'tools-ok', imageInput: true, imageTokens: { pixelsPerToken: 100_000, maxTokens: 100, minTokens: 50 } });
    expect(report.imageInputAccepted).toBe(true);
    expect(report.imageTokens).toBeUndefined();
    expect(isProbeReport(report)).toBe(true);
  });

  it('limits the output of every image measurement request to one token', async () => {
    const { fake } = await probe({ scenario: 'tools-ok', imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600 } });
    const imagePrompts = fake.requests.filter((request) => JSON.stringify(request.body ?? '').includes('Describe this image.'));
    expect(imagePrompts.length).toBeGreaterThan(3);
    expect(imagePrompts.every((request) => (request.body as { max_completion_tokens?: number }).max_completion_tokens === 1)).toBe(true);
  });

  it('waits for Retry-After on a 429 and repeats the request, keeping the whole probe', async () => {
    const waits: number[] = [];
    const { report } = await probe(
      {
        scenario: 'tools-ok',
        imageInput: true,
        imageTokens: { pixelsPerToken: 750, maxTokens: 1600 },
        rateLimitSizedImages: { count: 2, retryAfter: '3' },
        contextWindow: 8192,
        contextSizeExposure: 'models',
      },
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([3000, 3000]);
    expect(report.contextWindow).toEqual({ value: 8192, method: 'reported' });
    expect(report.imageTokens?.maxTokens).toBe(1600 + IMAGE_WRAPPER_TOKENS);
  });

  it('does not wait for a Retry-After longer than a step may take, and fails the step', async () => {
    const waits: number[] = [];
    await expect(
      probe(
        { scenario: 'tools-ok', imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600 }, rateLimitSizedImages: { count: 1, retryAfter: '3600' } },
        { sleep: async (ms) => void waits.push(ms), stepTimeoutMs: 5000 },
      ),
    ).rejects.toThrow(/HTTP 429/);
    expect(waits).toEqual([]);
  });

  it.each([400, 413] as const)('treats an HTTP %i for the large image as a measured size limit and keeps the rest of the probe', async (status) => {
    const { report } = await probe({
      scenario: 'tools-ok',
      imageInput: true,
      imageTokens: { pixelsPerToken: 750, maxTokens: 100_000 },
      imageSizeLimit: { maxSide: 1024, status },
      contextWindow: 8192,
      contextSizeExposure: 'models',
    });
    expect(report.contextWindow).toEqual({ value: 8192, method: 'reported' });
    expect(report.imageInputAccepted).toBe(true);
    expect(report.imageTokens?.pixelsPerToken).toBeGreaterThan(730);
    expect(report.imageTokens?.pixelsPerToken).toBeLessThan(760);
    expect(report.imageTokens?.maxTokens).toBeGreaterThanOrEqual(1345);
    expect(report.imageTokens?.maxTokens).toBeLessThanOrEqual(1399);
  });

  it('keeps the rest of the probe when even the small measurement image is over the size limit', async () => {
    const { report } = await probe({
      scenario: 'tools-ok',
      imageInput: true,
      imageTokens: { pixelsPerToken: 750, maxTokens: 100_000 },
      imageSizeLimit: { maxSide: 256, status: 413 },
      contextWindow: 8192,
      contextSizeExposure: 'models',
    });
    expect(report.contextWindow).toEqual({ value: 8192, method: 'reported' });
    expect(report.imageInputAccepted).toBe(true);
    expect(report.imageTokens?.maxTokens).toBeLessThanOrEqual(88 + IMAGE_WRAPPER_TOKENS);
  });

  it('measures a per-image minimum, so a fixed cost per image is estimated at that cost for a small image', async () => {
    const { report } = await probe({ scenario: 'tools-ok', imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 576, minTokens: 576 } });
    expect(report.imageTokens?.minTokens).toBe(576 + IMAGE_WRAPPER_TOKENS);
    expect(report.imageTokens?.maxTokens).toBe(576 + IMAGE_WRAPPER_TOKENS);
    expect(isProbeReport(report)).toBe(true);
  });

  it('classifies a large image that adds no tokens as no usable model instead of reporting a cap of zero', async () => {
    const { report } = await probe({ scenario: 'tools-ok', imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 100_000, noTokensAboveSide: 1024 } });
    expect(report.imageInputAccepted).toBe(true);
    expect(report.imageTokens).toBeUndefined();
    expect(isProbeReport(report)).toBe(true);
  });

  it('reports no image token model when usage is not reported', async () => {
    const { report } = await probe({ scenario: 'tools-ok', imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 1600 }, usageReported: false });
    expect(report.imageInputAccepted).toBe(true);
    expect(report.imageTokens).toBeUndefined();
  });

  it('measures max concurrency 1', async () => {
    const { report } = await probe(
      { scenario: 'tools-ok', latencyMs: SLOW_MS, maxConcurrency: 1, contextSizeExposure: 'models' },
      { samples: 1 },
    );
    expect(report.maxConcurrency).toBe(1);
  });

  it('measures max concurrency 2', async () => {
    const { report } = await probe(
      { scenario: 'tools-ok', latencyMs: SLOW_MS, maxConcurrency: 2, contextSizeExposure: 'models' },
      { samples: 1 },
    );
    expect(report.maxConcurrency).toBe(2);
  });

  it('builds the keyword support table from rejected keywords', async () => {
    const { report } = await probe({ scenario: 'tools-ok', unsupportedKeywords: ['pattern', 'minimum'] });
    expect(report.keywordSupport).toEqual({
      enum: true,
      anyOf: true,
      const: true,
      pattern: false,
      minimum: false,
      nested: true,
      additionalProperties: true,
    });
  });

  it('reads fm\'s unsupported generation guide error event as the keyword being unsupported, and completes the probe', async () => {
    const { report } = await probe(
      { scenario: 'tools-ok', wire: 'fm', contextSizeExposure: 'models', unsupportedKeywords: ['pattern', 'minimum'] },
      { vocabulary: FM_VOCABULARY },
    );
    expect(report.keywordSupport).toEqual({
      enum: true,
      anyOf: true,
      const: true,
      pattern: false,
      minimum: false,
      nested: true,
      additionalProperties: true,
    });
    expect(report.constrained.accepted).toBe(true);
    expect(isProbeReport(report)).toBe(true);
  });

  const isConstrainedSample = (body: unknown): boolean => {
    const messages = (body as { messages?: Array<{ role?: unknown; content?: unknown }> }).messages ?? [];
    return messages[0]?.role === 'system' && messages[0]?.content === 'Answer only with JSON that matches the given schema.';
  };

  it('stops the constrained samples at an fm error event that is a failure, as the native and parallel samples do', async () => {
    const failureEvent = { error: { message: 'The model failed to generate a response.', code: '500', type: 'server_error' } };
    const fake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      wire: 'fm',
      contextSizeExposure: 'models',
      routes: [{ match: isConstrainedSample, reply: { kind: 'error-event', body: failureEvent } }],
    });
    servers.push(fake);

    await expect(runProbe({ schemaDialect: 'guided-generation', socketPath: fake.socketPath, managedHealthRoute: true, now: fixedNow, samples: 5, vocabulary: FM_VOCABULARY })).rejects.toThrow(
      'failed with HTTP 200',
    );
    expect(fake.routeHits).toEqual([1]);
  });

  it('reads an fm unsupported generation guide error event on the constrained samples as constrained not accepted, and sends no more samples', async () => {
    const { report, fake } = await probe(
      {
        scenario: 'tools-ok',
        wire: 'fm',
        contextSizeExposure: 'models',
        routes: [{ match: isConstrainedSample, reply: { kind: 'error-event', body: FM_UNSUPPORTED_GUIDE_ERROR } }],
      },
      { samples: 5, vocabulary: FM_VOCABULARY },
    );
    expect(report.constrained).toEqual({ accepted: false, validRate: 0 });
    expect(fake.routeHits).toEqual([1]);
  });

  it('marks nested objects unsupported when rejected', async () => {
    const { report } = await probe({ scenario: 'tools-ok', unsupportedKeywords: ['nested', 'additionalProperties'] });
    expect(report.keywordSupport?.nested).toBe(false);
    expect(report.keywordSupport?.additionalProperties).toBe(false);
    expect(report.keywordSupport?.enum).toBe(true);
  });

  it('records the guardrail error shape when the guardrail prompt triggers it', async () => {
    const { report } = await probe(
      { scenario: 'tools-ok', guardrailTrigger: 'GUARDRAIL-PROBE' },
      { guardrailPrompt: 'please discuss GUARDRAIL-PROBE' },
    );
    expect(report.guardrail.errorShape).toEqual(FAKE_GUARDRAIL_ERROR);
  });

  it('records the guardrail error shape fm sends as an error event inside a 200 stream, through the same decoded error kind', async () => {
    const { report } = await probe(
      {
        scenario: 'tools-ok',
        wire: 'fm',
        routes: [{ match: (body) => JSON.stringify(body).includes('GUARDRAIL-PROBE'), reply: { kind: 'error-event', body: FM_GUARDRAIL_ERROR } }],
      },
      { guardrailPrompt: 'please discuss GUARDRAIL-PROBE', vocabulary: FM_VOCABULARY },
    );
    expect(report.guardrail.errorShape).toEqual(FM_GUARDRAIL_ERROR);
  });

  it('leaves the guardrail error shape undefined when nothing triggers', async () => {
    const { report } = await probe({ scenario: 'tools-ok' }, { guardrailPrompt: 'please discuss GUARDRAIL-PROBE' });
    expect(report.guardrail.errorShape).toBeUndefined();
  });
});

describe('runProbe streaming and usage', () => {
  it('detects streaming with the DONE sentinel and no usage in stream', async () => {
    const { report } = await probe({ scenario: 'tools-ok' });
    expect(report.streaming).toEqual({ supported: true, doneSentinel: true, usageInStream: false });
    expect(report.usageReported).toBe(true);
  });

  it('detects usage in stream', async () => {
    const { report } = await probe({ scenario: 'tools-ok', streamUsage: true });
    expect(report.streaming).toEqual({ supported: true, doneSentinel: true, usageInStream: true });
  });

  it('detects missing usage and skips calibration', async () => {
    const { report } = await probe({ scenario: 'tools-ok', usageReported: false }, { countTokens: async (text: string) => words(text) });
    expect(report.usageReported).toBe(false);
    expect(report.tokenCalibration).toBeUndefined();
  });

  it('omits calibration without a token counter', async () => {
    const { report } = await probe({ scenario: 'tools-ok' });
    expect(report.tokenCalibration).toBeUndefined();
  });

  it('computes the calibration ratio as reported tokens over counted tokens', async () => {
    const single = (await probe({ scenario: 'tools-ok' }, { countTokens: async (text: string) => words(text) })).report.tokenCalibration;
    const doubled = (await probe({ scenario: 'tools-ok' }, { countTokens: async (text: string) => 2 * words(text) })).report.tokenCalibration;
    expect(single).toBeDefined();
    expect(doubled).toBeDefined();
    expect(single?.ratio).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(single?.ratio)).toBe(true);
    expect((single?.ratio ?? 0) / (doubled?.ratio ?? 1)).toBeCloseTo(2, 6);
    expect(single?.errorBound).toBeGreaterThanOrEqual(0);
  });
});

describe('runProbe context window calibration', () => {
  it('fails the probe naming payload_too_large when the search meets a 413 request_too_large, instead of recording a byte limit as the window', async () => {
    const requestTooLarge = { type: 'error', error: { type: 'request_too_large', message: 'Request exceeds the maximum allowed number of bytes.' } };
    const fake = await startFakeChatCompletions({
      scenario: 'tools-ok',
      contextWindow: 100_000,
      contextSizeExposure: 'none',
      routes: [
        {
          match: (body) => (body as { max_completion_tokens?: unknown }).max_completion_tokens === 1 && JSON.stringify(body).length > 20000,
          reply: { kind: 'error', status: 413, body: requestTooLarge },
        },
      ],
    });
    servers.push(fake);

    await expect(runProbe({ schemaDialect: 'json-schema-2020-12', socketPath: fake.socketPath, managedHealthRoute: true, samples: 2 })).rejects.toThrow(/payload_too_large.*413/);
  });

  it('records the first overflow response body for a context_length_exceeded 400', async () => {
    const { report } = await probe({ scenario: 'tools-ok', contextWindow: 3000 });
    expect(report.contextWindow.overflowErrorShape).toMatchObject({ error: { code: 'context_length_exceeded' } });
  });

  it('aborts the search on a 5xx response', async () => {
    await expect(probe({ scenario: 'tools-ok', contextWindow: 3000, contextOverflowStatus: 500 })).rejects.toThrow(/HTTP 500/);
  });

  it('aborts when the window exceeds the maximum searched prompt size', async () => {
    await expect(probe({ scenario: 'tools-ok', contextWindow: 1_000_000 })).rejects.toThrow(/maximum prompt size/);
  });

  it('reads a nested field of the first model entry', async () => {
    const { report } = await probe({ scenario: 'tools-ok', contextWindow: 7777, contextSizeExposure: 'models-nested' });
    expect(report.contextWindow).toEqual({ value: 7777, method: 'reported' });
  });

  it('reads a nested field of the health response', async () => {
    const { report } = await probe({ scenario: 'tools-ok', contextWindow: 5555, contextSizeExposure: 'health-nested' });
    expect(report.contextWindow).toEqual({ value: 5555, method: 'reported' });
  });
});

describe('runProbe concurrency measurement', () => {
  it('reports 1 for a server that queues requests instead of rejecting them', async () => {
    const { report } = await probe(
      { scenario: 'tools-ok', latencyMs: SLOW_MS, maxConcurrency: 1, overflow: 'queue', contextSizeExposure: 'models' },
      { samples: 1 },
    );
    expect(report.maxConcurrency).toBe(1);
  });
});

describe('runProbe sampling resilience', () => {
  it('keeps accepted true and lowers the valid rate when a later native sample is rejected', async () => {
    const { report } = await probe({ scenario: 'tools-ok', failNativeSamples: [3] });
    expect(report.nativeTools).toEqual({ accepted: true, validRate: 0.9, roundTripOk: true });
  });

  it('decides native acceptance from the first request only', async () => {
    const { report } = await probe({ scenario: 'tools-ok', failNativeSamples: [0] });
    expect(report.nativeTools.accepted).toBe(false);
    expect(report.nativeTools.validRate).toBe(0);
  });

  it('lowers the constrained valid rate when a later constrained sample is rejected', async () => {
    const { report } = await probe({ scenario: 'tools-ok', failConstrainedSamples: [2] });
    expect(report.constrained).toEqual({ accepted: true, validRate: 0.9 });
  });

  it('counts a timed-out native sample as invalid', async () => {
    const { report } = await probe(
      { scenario: 'tools-ok', stallNativeSamples: [2], stallMs: 10000, maxConcurrency: 4 },
      { stepTimeoutMs: 500 },
    );
    expect(report.nativeTools).toEqual({ accepted: true, validRate: 0.9, roundTripOk: true });
  });
});

describe('runProbe deadlines', () => {
  it('disposes every deadline it creates', async () => {
    const created = vi.spyOn(Deadline, 'after');
    const disposed = vi.spyOn(Deadline.prototype, 'dispose');
    try {
      await probe({ scenario: 'tools-ok', contextSizeExposure: 'models' }, { samples: 2 });
      const instances = created.mock.results.map((result) => result.value as Deadline);
      expect(instances.length).toBeGreaterThan(10);
      const disposedInstances = new Set(disposed.mock.contexts);
      expect(instances.filter((instance) => !disposedInstances.has(instance))).toEqual([]);
    } finally {
      created.mockRestore();
      disposed.mockRestore();
    }
  });
});

describe('runProbe step timeout and client lifecycle', () => {
  it('aborts with a clear error when a mandatory step exceeds stepTimeoutMs', async () => {
    const error = await probe({ scenario: 'tools-ok', latencyMs: 800 }, { stepTimeoutMs: 100 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProbeTimeoutError);
    expect((error as Error).message).toMatch(/POST \/v1\/chat\/completions timed out after 100 ms/);
  });

  it('closes its connections after a successful probe', async () => {
    const { fake } = await probe({ scenario: 'tools-ok' });
    await vi.waitFor(() => expect(fake.openConnections()).toBe(0));
  });

  it('closes its connections after a failed probe', async () => {
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', latencyMs: 800 });
    servers.push(fake);
    await expect(runProbe({ schemaDialect: 'json-schema-2020-12', socketPath: fake.socketPath, stepTimeoutMs: 100 })).rejects.toThrow();
    await vi.waitFor(() => expect(fake.openConnections()).toBe(0));
  });
});
