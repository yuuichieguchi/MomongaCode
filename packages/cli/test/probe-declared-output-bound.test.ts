import { describe, expect, it } from 'vitest';
import { probeEndpointText, probeFmText } from '../src/commands/gateway.ts';

const reportMeasuring = (outputBoundField: string | undefined) =>
  ({
    modelId: 'm',
    contextWindow: { value: 8, method: 'reported' },
    nativeTools: { validRate: 1 },
    constrained: { accepted: true, validRate: 1 },
    stopSequences: false,
    usageReported: true,
    maxConcurrency: 1,
    schemaDialect: { selected: 'json-schema-2020-12', shape: 'union', tried: [] },
    ...(outputBoundField === undefined ? {} : { outputBoundField }),
  }) as unknown as Parameters<typeof probeEndpointText>[3];

describe('the probe output on a declared output bound field', () => {
  it('says so when the declaration contradicts the measurement, and keeps the declaration', () => {
    const text = probeEndpointText('t', 'http://e', '/r', reportMeasuring('max_completion_tokens'), 'native', undefined, 'max_tokens');
    expect(text).toContain('output bound: max_completion_tokens; the settings declare max_tokens, which stays in force over this measurement');
    expect(probeFmText('t', '/r', reportMeasuring('none'), 'native', 'max_tokens')).toContain('neither max_completion_tokens nor max_tokens is honoured; the settings declare max_tokens');
  });

  it('says nothing about a declaration that agrees with the measurement or when nothing is declared or measured', () => {
    expect(probeEndpointText('t', 'http://e', '/r', reportMeasuring('max_tokens'), 'native', undefined, 'max_tokens')).not.toContain('declare');
    expect(probeEndpointText('t', 'http://e', '/r', reportMeasuring('max_tokens'), 'native', undefined)).not.toContain('declare');
    expect(probeFmText('t', '/r', reportMeasuring(undefined), 'native', 'max_tokens')).not.toContain('declare');
  });
});
