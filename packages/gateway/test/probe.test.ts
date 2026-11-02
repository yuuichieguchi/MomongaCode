import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProbeTimeoutError, runProbe } from '@momonga/gateway';
import { Deadline } from '@momonga/foundation';
import type { ProbeReport } from '@momonga/protocol';
import {
  FAKE_GUARDRAIL_ERROR,
  FAKE_PAYLOAD_TOO_LARGE_ERROR,
  startFakeChatCompletions,
  type FakeChatCompletionsOptions,
  type FakeChatCompletionsServer,
} from '@momonga/testkit';

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const fixedNow = () => new Date('2026-10-23T12:00:00.000Z');

const probe = async (
  options: FakeChatCompletionsOptions,
  probeOptions: Omit<Parameters<typeof runProbe>[0], 'socketPath'> = {},
): Promise<{ report: ProbeReport; fake: FakeChatCompletionsServer }> => {
  const fake = await startFakeChatCompletions(options);
  servers.push(fake);
  const report = await runProbe({ socketPath: fake.socketPath, now: fixedNow, ...probeOptions });
  return { report, fake };
};

const SLOW_MS = 150;

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
    expect(report.imageTokens?.maxTokens).toBe(1600);
    expect(report.imageTokens?.pixelsPerToken).toBeGreaterThan(740);
    expect(report.imageTokens?.pixelsPerToken).toBeLessThan(760);
  });

  it('reports no image token model when the endpoint caps no image within the probe range', async () => {
    const { report } = await probe({ scenario: 'tools-ok', imageInput: true, imageTokens: { pixelsPerToken: 750, maxTokens: 100_000 } });
    expect(report.imageInputAccepted).toBe(true);
    expect(report.imageTokens).toBeUndefined();
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

  it('marks nested objects unsupported when rejected', async () => {
    const { report } = await probe({ scenario: 'tools-ok', unsupportedKeywords: ['nested', 'additionalProperties'] });
    expect(report.keywordSupport.nested).toBe(false);
    expect(report.keywordSupport.additionalProperties).toBe(false);
    expect(report.keywordSupport.enum).toBe(true);
  });

  it('records the guardrail error shape when the guardrail prompt triggers it', async () => {
    const { report } = await probe(
      { scenario: 'tools-ok', guardrailTrigger: 'GUARDRAIL-PROBE' },
      { guardrailPrompt: 'please discuss GUARDRAIL-PROBE' },
    );
    expect(report.guardrail.errorShape).toEqual(FAKE_GUARDRAIL_ERROR);
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
  it('treats a 413 response as too large and records its body', async () => {
    const { report } = await probe({ scenario: 'tools-ok', contextWindow: 3000, contextOverflowStatus: 413 });
    expect(report.contextWindow.method).toBe('searched');
    expect(Math.abs(report.contextWindow.value - 3000)).toBeLessThanOrEqual(60);
    expect(report.contextWindow.overflowErrorShape).toEqual(FAKE_PAYLOAD_TOO_LARGE_ERROR);
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
    await expect(runProbe({ socketPath: fake.socketPath, stepTimeoutMs: 100 })).rejects.toThrow();
    await vi.waitFor(() => expect(fake.openConnections()).toBe(0));
  });
});
