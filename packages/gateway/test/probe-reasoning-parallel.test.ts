import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesFromProbe, decideToolCalling, runProbe } from '@momonga/gateway';
import type { ProbeReport } from '@momonga/protocol';
import { startFakeChatCompletions } from '@momonga/testkit';
import type { FakeChatCompletionsOptions, FakeChatCompletionsServer } from '@momonga/testkit';
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

  it('trusts acceptance when the usage does not report reasoning tokens separately', async () => {
    const { report } = await probe({ scenario: 'tools-ok', reasoning: { tokens: 200, effort: 'ignored', reportsUsage: false } });
    expect(report.reasoning).toEqual({ control: 'reasoning_effort', lowest: 'none' });
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
