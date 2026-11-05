import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTEXT_DATASET_FORMAT, QUALITY_METRICS, buildContextReport, compareContextReports, parseContextDataset } from '@momonga/eval';
import type { ContextReport } from '@momonga/eval';
import { REAL_TARGET, answeredBy } from './answered-fixtures.ts';
import { contextCase, recorded } from './context-fixtures.ts';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const NON_QUALITY_METRICS = [
  'contrastiveFailures',
  'lossSignalsPerCompaction',
  'fabricationRate',
  'identifierRetention',
  'tokensPerSuccess',
  'costPerSuccess',
  'uncachedInputPerSuccess',
  'callsPerSuccess',
  'latencyPerSuccess',
  'cacheHitRatio',
  'layerShares',
];

const contextMetricsFields = (): string[] => {
  const text = readFileSync(path.join(SOURCE, 'context-report.ts'), 'utf8');
  const body = /export type ContextMetrics = \{([\s\S]*?)\n\};/.exec(text);
  if (body === null) throw new Error('ContextMetrics is not declared in context-report.ts');
  return [...(body[1] as string).matchAll(/^\s+(\w+)\??:/gm)].map((match) => match[1] as string);
};

const dataset = parseContextDataset(
  JSON.stringify({ format: CONTEXT_DATASET_FORMAT, name: 'drift', cases: [contextCase('a-on', 'a', 'on'), contextCase('a-off', 'a', 'off')] }),
  'drift.json',
);

const report = (): ContextReport =>
  buildContextReport({
    dataset,
    transcripts: [answeredBy(recorded('a-on', 0, []), REAL_TARGET), answeredBy(recorded('a-off', 0, []), REAL_TARGET)],
    seed: 1,
  } as Parameters<typeof buildContextReport>[0]);

const names = (): string[] => (QUALITY_METRICS as readonly { name: string }[]).map((metric) => metric.name);

describe('the quality metrics, the report and the gates cannot drift apart', () => {
  it('QUALITY_METRICS has seven entries, each with a direction', () => {
    expect(names()).toHaveLength(7);
    for (const metric of QUALITY_METRICS as readonly { direction: string }[]) expect(['higher', 'lower']).toContain(metric.direction);
  });

  it.each(['context', 'token'] as const)('every key of QUALITY_METRICS has a term in the %s gate', (gate) => {
    const checks = compareContextReports(report(), { ...report(), codeDigest: 'd'.repeat(64) }, { seed: 1, gate }).gate.checks.map((check) => check.name);
    expect(names().length).toBeGreaterThan(0);
    for (const name of names()) expect(checks).toContain(name);
  });

  it('every key of QUALITY_METRICS is a field of ContextMetrics', () => {
    const fields = contextMetricsFields();
    expect(names().length).toBeGreaterThan(0);
    for (const name of names()) expect(fields).toContain(name);
  });

  it('ContextMetrics has no quality field outside the table', () => {
    const outside = contextMetricsFields().filter((field) => !names().includes(field) && !NON_QUALITY_METRICS.includes(field));
    expect(names().length).toBeGreaterThan(0);
    expect(outside).toEqual([]);
  });

  it('every case report carries a quality cell for each key of the table', () => {
    for (const entry of report().cases) {
      const quality = (entry as unknown as { quality?: Record<string, unknown> }).quality;
      expect(Object.keys(quality ?? {}).sort()).toEqual([...names()].sort());
    }
  });
});
