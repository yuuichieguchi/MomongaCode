import { describe, expect, it } from 'vitest';
import { probeEndpointText, probeFmText } from '../src/commands/gateway.ts';

type Report = Parameters<typeof probeEndpointText>[3];

const reportWith = (maxConcurrency: Report['maxConcurrency']): Report =>
  ({
    modelId: 'm',
    contextWindow: { value: 8, method: 'reported' },
    nativeTools: { validRate: 1 },
    constrained: { accepted: true, validRate: 1 },
    stopSequences: false,
    usageReported: true,
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
    schemaDialect: { selected: 'explicit-keys', shape: 'union', tried: [] },
  }) as unknown as Report;

describe('the probe output names how the max concurrency is known', () => {
  it('prints a measured value with the refusal it comes from', () => {
    const measured = reportWith({ value: 3, evidence: 'refused' });
    expect(probeEndpointText('t', 'http://e', '/r', measured, 'native', undefined)).toContain('max concurrency: 3 (the server refused more at once)');
    expect(probeFmText('t', '/r', measured, 'native')).toContain('max concurrency: 3 (the server refused more at once)');
  });

  it('prints an unmeasured value as not measured, with the way to declare it', () => {
    const unmeasured = reportWith(undefined);
    expect(probeEndpointText('t', 'http://e', '/r', unmeasured, 'native', undefined)).toContain('max concurrency: not measured (the server refused no request; maxConcurrency in the settings declares it, one request at a time otherwise)');
    expect(probeFmText('t', '/r', unmeasured, 'native')).toContain('max concurrency: not measured');
  });
});
