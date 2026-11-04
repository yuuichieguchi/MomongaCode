import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesFromProbe, decideToolCalling, runProbe } from '@momonga/gateway';
import { ESTIMATED_ERROR_BOUND_RATIO, summaryInputLimitFor, summaryTokenCapFor, tokensForText } from '@momonga/protocol';
import type { ProbeReport } from '@momonga/protocol';
import { FAKE_DETERMINISTIC_REPLY, FAKE_REASONING_WORD, countFakeTokens, startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsOptions, FakeChatCompletionsServer } from '@momonga/testkit';
import { COMPACTION_INSTRUCTIONS_MARKER } from '../src/adapters/shared/compact.ts';
import { maxOutputTokensFor } from '../src/probe/decide.ts';
import { isProbeReport } from '../src/probe/report-schema.ts';

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const probe = async (options: FakeChatCompletionsOptions): Promise<{ report: ProbeReport; fake: FakeChatCompletionsServer }> => {
  const fake = await startFakeChatCompletions(options);
  servers.push(fake);
  const report = await runProbe({ socketPath: fake.socketPath, samples: 4, now: () => new Date('2026-10-23T12:00:00.000Z') });
  return { report, fake };
};

describe('probe of reasoning control', () => {
  it('finds the lowest effort a target honours, by the reasoning tokens its usage reports', async () => {
    const { report } = await probe({ scenario: 'tools-ok', reasoning: { tokens: 200, effort: 'honoured' } });
    expect(report.reasoning).toEqual({ control: 'reasoning_effort', lowest: 'none' });
  });

  it('records the reasoning a target spends when it accepts the setting but ignores it, as room for the output cap', async () => {
    const { report } = await probe({ scenario: 'tools-ok', reasoning: { tokens: 200, effort: 'ignored' } });
    expect(report.reasoning).toEqual({ control: 'none', headroomTokens: 200 });
  });

  it('records no control when the target rejects the setting', async () => {
    const { report } = await probe({ scenario: 'tools-ok', reasoning: { tokens: 200, effort: 'rejected' } });
    expect(report.reasoning).toEqual({ control: 'none', headroomTokens: 200 });
  });

  it('measures hidden reasoning from the completion tokens when the usage does not break it out: the visible answer is subtracted from the completion tokens', async () => {
    const { report } = await probe({ scenario: 'tools-ok', reasoning: { tokens: 204, effort: 'ignored', reportsUsage: false } });
    const completionTokens = countFakeTokens(FAKE_DETERMINISTIC_REPLY) + 204;
    expect(report.reasoning).toEqual({ control: 'none', headroomTokens: completionTokens - tokensForText(FAKE_DETERMINISTIC_REPLY) });
  });

  it('still finds a control the server honours when only the completion tokens show it', async () => {
    const { report } = await probe({ scenario: 'tools-ok', reasoning: { tokens: 204, effort: 'honoured', reportsUsage: false } });
    expect(report.reasoning).toEqual({ control: 'reasoning_effort', lowest: 'none' });
  });

  it.for(['reasoning_content', 'reasoning'] as const)('measures hidden reasoning from the size of the %s field when no usage is reported', async (field) => {
    const { report } = await probe({ scenario: 'tools-ok', usageReported: false, reasoning: { tokens: 200, effort: 'ignored', reportsUsage: false, field } });
    expect(report.reasoning).toEqual({ control: 'none', headroomTokens: tokensForText(FAKE_REASONING_WORD.repeat(200).trimEnd()) });
  });

  it('finds the control through the reasoning field alone when the server honours the setting', async () => {
    const { report } = await probe({ scenario: 'tools-ok', usageReported: false, reasoning: { tokens: 200, effort: 'honoured', reportsUsage: false, field: 'reasoning_content' } });
    expect(report.reasoning).toEqual({ control: 'reasoning_effort', lowest: 'none' });
  });

  it('records no control and no headroom when nothing about the hidden reasoning can be measured', async () => {
    const { report } = await probe({ scenario: 'tools-ok', usageReported: false, reasoning: { tokens: 200, effort: 'ignored', reportsUsage: false } });
    expect(report.reasoning).toEqual({ control: 'none' });
  });

  it('measures the headroom on a summary-shaped request of the size the summary input bound allows, with room for the reasoning to finish', async () => {
    const window = 4096;
    const { fake } = await probe({ scenario: 'tools-ok', contextSizeExposure: 'models', contextWindow: window, reasoning: { tokens: 200, effort: 'ignored' } });
    const maxOutputTokens = maxOutputTokensFor(window);
    const limit = summaryInputLimitFor({ contextWindow: window, maxOutputTokens }, summaryTokenCapFor({ contextWindow: window }), 0);
    const bound = limit / (1 + ESTIMATED_ERROR_BOUND_RATIO);
    const summaries = fake.requests
      .filter((request) => request.path === '/v1/chat/completions')
      .map((request) => request.body as { max_completion_tokens?: number; messages: Array<{ role: string; content: string }> })
      .filter((body) => String(body.messages[0]?.content).includes(COMPACTION_INSTRUCTIONS_MARKER));

    expect(summaries.length).toBeGreaterThanOrEqual(2);
    for (const body of summaries) {
      expect(body.max_completion_tokens).toBe(maxOutputTokens);
      const tokens = body.messages.reduce((sum, message) => sum + tokensForText(message.content), 0);
      expect(tokens).toBeGreaterThan(0.9 * bound);
      expect(tokens).toBeLessThanOrEqual(bound);
    }
  });

  it('does not accept a baseline request that the server refuses', async () => {
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', routes: [{ match: (body) => String((body as { messages?: Array<{ content?: unknown }> }).messages?.[0]?.content).includes(COMPACTION_INSTRUCTIONS_MARKER), reply: { kind: 'error', status: 400, body: { error: { message: 'bad', type: 'invalid_request_error', param: null, code: null } } } }] });
    servers.push(fake);
    await expect(runProbe({ socketPath: fake.socketPath, samples: 1 })).rejects.toThrow('reasoning baseline');
  });

  it('reports a model without reasoning as accepting the lowest effort and needing no room', async () => {
    const { report } = await probe({ scenario: 'tools-ok' });
    expect(report.reasoning).toEqual({ control: 'reasoning_effort', lowest: 'none' });
  });

  it('puts the measurement into the capabilities', async () => {
    const { report } = await probe({ scenario: 'tools-ok', reasoning: { tokens: 200, effort: 'ignored' } });
    const capabilities = capabilitiesFromProbe(report, decideToolCalling(report));
    expect(capabilities.reasoning).toEqual({ control: 'none', headroomTokens: 200 });
  });
});

describe('probe of parallel tool calls', () => {
  it('measures how often one reply carries several calls', async () => {
    const { report } = await probe({ scenario: 'tools-ok', parallelToolCalls: true });
    expect(report.parallelToolCalls).toEqual({ accepted: true, multiCallRate: 1 });
    expect(capabilitiesFromProbe(report, decideToolCalling(report)).parallelToolCalls).toBe(true);
  });

  it('reports a target that answers one call at a time as not supporting parallel calls', async () => {
    const { report } = await probe({ scenario: 'tools-ok', parallelToolCalls: false });
    expect(report.parallelToolCalls).toEqual({ accepted: true, multiCallRate: 0 });
    expect(capabilitiesFromProbe(report, decideToolCalling(report)).parallelToolCalls).toBe(false);
  });

  it('writes a report that its own schema accepts', async () => {
    const { report } = await probe({ scenario: 'tools-ok', parallelToolCalls: true, reasoning: { tokens: 50, effort: 'honoured' } });
    expect(isProbeReport(report)).toBe(true);
  });
});
