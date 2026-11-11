import { afterEach, describe, expect, it } from 'vitest';
import { capabilitiesFromProbe, runProbe } from '@momonga/gateway';
import { countFakeRequestTokens, startFakeChatCompletions, type FakeChatCompletionsOptions, type FakeChatCompletionsServer } from '@momonga/testkit';
import { isProbeReport } from '../src/probe/report-schema.ts';
import { FM_PROBE_ROUTES } from './fm-record-support.ts';
import { hostProbePorts } from './probe-ports-support.ts';

const servers: FakeChatCompletionsServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const probeWith = async (options: FakeChatCompletionsOptions) => {
  const fake = await startFakeChatCompletions(options);
  servers.push(fake);
  const report = await runProbe({ ports: hostProbePorts, socketPath: fake.socketPath, managed: FM_PROBE_ROUTES, samples: 2 });
  return { report, fake };
};

type Body = { max_tokens?: unknown; max_completion_tokens?: unknown };

const generatingBodies = (fake: FakeChatCompletionsServer): Body[] =>
  fake.requests.filter((request) => request.path === '/v1/chat/completions').map((request) => request.body as Body);

describe('the probe measures which output bound field the upstream honours', () => {
  it.each([
    ['max_completion_tokens', 'max_completion_tokens'],
    ['max_tokens', 'max_tokens'],
    ['both', 'max_completion_tokens'],
  ] as const)('records the field for an upstream honouring %s', async (honours, recorded) => {
    const { report } = await probeWith({ scenario: 'tools-ok', outputBound: { honours } });

    expect(report.outputBoundField).toBe(recorded);
    expect(isProbeReport(report)).toBe(true);
  });

  it('records none for an upstream honouring neither field', async () => {
    const { report } = await probeWith({ scenario: 'tools-ok', outputBound: { honours: 'neither' } });

    expect(report.outputBoundField).toBe('none');
    expect(isProbeReport(report)).toBe(true);
  });

  it('carries the honoured field, and only that field, on every request after the measurement', async () => {
    const { fake } = await probeWith({ scenario: 'tools-ok', outputBound: { honours: 'max_tokens' } });

    const afterMeasurement = generatingBodies(fake).filter((body) => typeof body.max_completion_tokens !== 'number');
    expect(afterMeasurement.length).toBeGreaterThan(0);
    expect(afterMeasurement.every((body) => typeof body.max_tokens === 'number')).toBe(true);
    expect(generatingBodies(fake).filter((body) => typeof body.max_completion_tokens === 'number')).toHaveLength(1);
  });

  it('measures the field before any other generating request and bounds every request by what fits the window', async () => {
    const window = 3000;
    const { fake, report } = await probeWith({ scenario: 'tools-ok', contextWindow: window, contextSizeExposure: 'none', outputBound: { honours: 'max_completion_tokens' } });

    const bodies = fake.requests.filter((request) => request.path === '/v1/chat/completions').map((request) => request.body);
    expect(bodies.every((body) => typeof (body as Body).max_completion_tokens === 'number')).toBe(true);
    const fitting = bodies.filter((body) => countFakeRequestTokens(body) < report.contextWindow.value);
    const overWindow = fitting.filter((body) => countFakeRequestTokens(body) + ((body as Body).max_completion_tokens as number) > report.contextWindow.value);
    expect(overWindow).toEqual([]);
  });

  it('turns the measured field into the capability, and leaves the capability out when neither is honoured', async () => {
    const honoured = await probeWith({ scenario: 'tools-ok', outputBound: { honours: 'max_tokens' } });
    const neither = await probeWith({ scenario: 'tools-ok', outputBound: { honours: 'neither' } });

    expect(capabilitiesFromProbe(honoured.report, { mode: 'native' }).outputBoundField).toBe('max_tokens');
    expect(capabilitiesFromProbe(neither.report, { mode: 'native' })).not.toHaveProperty('outputBoundField');
  });
});
