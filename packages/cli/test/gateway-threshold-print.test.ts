import { describe, expect, it } from 'vitest';
import { capabilitiesFromProbe, decideToolCalling } from '@momonga/gateway';
import { probeEndpointText } from '../src/commands/gateway.ts';

type Report = Parameters<typeof probeEndpointText>[3];

const reportWith = (multiCallRate: number): Report =>
  ({
    modelId: 'm',
    contextWindow: { value: 8, method: 'reported' },
    nativeTools: { accepted: true, validRate: 1 },
    constrained: { accepted: true, validRate: 1 },
    stopSequences: false,
    streaming: { supported: true },
    imageInputAccepted: false,
    probedAt: '2026-11-12T00:00:00.000Z',
    usageReported: true,
    parallelToolCalls: { accepted: true, multiCallRate },
    schemaDialect: { selected: 'explicit-keys', shape: 'union', tried: [] },
  }) as unknown as Report;

const parallelLine = (text: string): string | undefined => text.split('\n').find((line) => line.includes('parallel tool calls:'));

describe('the printed parallel tool calls verdict is the decided one', () => {
  it.each([0.5, 0.89, 0.9, 0.95])('a multi-call rate of %s prints the recorded decision', (rate) => {
    const report = reportWith(rate);
    const decided = capabilitiesFromProbe(report as never, decideToolCalling(report as never)).parallelToolCalls;
    const text = probeEndpointText('t', 'http://e', '/r', report, 'native', decided);
    expect(parallelLine(text)).toBe(`  parallel tool calls: ${String(decided)} (${rate} of replies carried several calls)`);
  });

  it('prints not measured when nothing was decided', () => {
    const report = { ...reportWith(1), parallelToolCalls: undefined } as unknown as Report;
    expect(parallelLine(probeEndpointText('t', 'http://e', '/r', report, 'native', undefined))).toBe('  parallel tool calls: not measured');
  });
});
