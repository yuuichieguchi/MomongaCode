import { describe, expect, it } from 'vitest';
import { probeEndpointText, probeFmText } from '../src/commands/gateway.ts';

const reportWith = (schemaDialect: unknown) =>
  ({
    modelId: 'm',
    contextWindow: { value: 8, method: 'reported' },
    nativeTools: { validRate: 1 },
    constrained: { accepted: true, validRate: 1 },
    stopSequences: false,
    usageReported: true,
    maxConcurrency: 1,
    schemaDialect,
  }) as unknown as Parameters<typeof probeEndpointText>[3];

const SELECTED = reportWith({ selected: 'explicit-keys', shape: 'union', tried: [{ id: 'json-schema-2020-12', result: 'refused', detail: 'Object schemas require a title key' }, { id: 'explicit-keys', result: 'accepted' }] });
const REFUSED = reportWith({ selected: null, shape: null, tried: [{ id: 'strict-closed', result: 'refused', detail: 'Invalid schema: additionalProperties' }] });

const dialectLine = (text: string): string => text.split('\n').find((line) => line.includes('schema dialect')) ?? '';

describe('the probe output names the measured dialect (rule 4) and a refused declaration (decision b)', () => {
  it('prints the selected dialect and its shape for an endpoint and for fm', () => {
    expect(dialectLine(probeEndpointText('t', 'http://e', '/r', SELECTED, 'native', undefined))).toContain('explicit-keys');
    expect(dialectLine(probeEndpointText('t', 'http://e', '/r', SELECTED, 'native', undefined))).toContain('union');
    expect(dialectLine(probeFmText('t', '/r', SELECTED, 'constrained'))).toContain('explicit-keys');
  });

  it('prints the refusal of a declared dialect with the server reason', () => {
    const line = dialectLine(probeEndpointText('t', 'http://e', '/r', REFUSED, 'native', undefined));
    expect(line).toContain('strict-closed');
    expect(line).toContain('refused');
    expect(line).toContain('Invalid schema: additionalProperties');
    expect(dialectLine(probeFmText('t', '/r', REFUSED, 'native'))).toContain('Invalid schema: additionalProperties');
  });
});
