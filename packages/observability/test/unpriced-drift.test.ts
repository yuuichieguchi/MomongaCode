import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RUN_API_SCHEMAS, UNPRICED_CODES } from '@momonga/protocol';
import { UNPRICED_CODE_TEXT, definePriceTable, priceCall } from '@momonga/observability';
import type { CallBilling, CostUsage } from '@momonga/observability';

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));

const sourcesUnder = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sourcesUnder(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });

const SURFACES = [
  join(PACKAGES, 'observability/src/cost-report.ts'),
  join(PACKAGES, 'observability/src/cost-breakdown.ts'),
  ...sourcesUnder(join(PACKAGES, 'eval/src')),
  ...sourcesUnder(join(PACKAGES, 'cli/src')),
];

const unpricedEnums = (value: unknown, found: unknown[][] = []): unknown[][] => {
  if (Array.isArray(value)) {
    for (const item of value) unpricedEnums(item, found);
    return found;
  }
  if (value === null || typeof value !== 'object') return found;
  const record = value as Record<string, unknown>;
  const properties = record['properties'] as Record<string, unknown> | undefined;
  const unpriced = properties?.['unpriced'] as { properties?: { code?: { enum?: unknown[] } } } | undefined;
  const codes = unpriced?.properties?.code?.enum;
  if (codes !== undefined) found.push(codes);
  for (const child of Object.values(record)) unpricedEnums(child, found);
  return found;
};

describe('UNPRICED_CODES is the one source of the codes (DC.6 item 8)', () => {
  it('keys UNPRICED_CODE_TEXT by exactly the codes of the list', () => {
    expect(Object.keys(UNPRICED_CODE_TEXT).sort()).toEqual([...UNPRICED_CODES].sort());
  });

  it('gives every code of the list from some branch of priceCall, and no other code', () => {
    const at = new Date(Date.parse('2026-07-10T00:00:00Z'));
    const table = definePriceTable([{ provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 1, outputPerMTok: 4, currency: 'USD' }]);
    const inputs: readonly { billing: CallBilling; model: string; usage: CostUsage }[] = [
      { billing: 'plan', model: 'm1', usage: { inputTokens: 1, outputTokens: 1 } },
      { billing: 'unknown', model: 'm1', usage: { inputTokens: 1, outputTokens: 1 } },
      { billing: 'metered', model: 'unlisted', usage: { inputTokens: 1, outputTokens: 1 } },
      { billing: 'metered', model: 'm1', usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 1 } },
      { billing: 'metered', model: 'm1', usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const codes = new Set(
      inputs.flatMap((input) => {
        const outcome = priceCall({ provider: 'acme', at, table, ...input }) as { kind: string; code?: string };
        return outcome.kind === 'unpriced' ? [String(outcome.code)] : [];
      }),
    );
    expect([...codes].sort()).toEqual([...UNPRICED_CODES].sort());
  });

  it('is the enum of every unpriced code in the wire schemas', () => {
    const enums = unpricedEnums(RUN_API_SCHEMAS);
    expect(enums.length).toBeGreaterThan(0);
    for (const codes of enums) expect(codes).toEqual([...UNPRICED_CODES]);
  });
});

describe('no surface writes a code text itself (I-P4)', () => {
  it('finds no literal of a code text in the cost report, the breakdown, eval or the cli', () => {
    const texts: string[] = Object.values(UNPRICED_CODE_TEXT);
    expect(texts.length).toBe(UNPRICED_CODES.length);
    const offenders = SURFACES.flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return texts.filter((text) => source.includes(text)).map((text) => `${path.slice(PACKAGES.length)}: ${text}`);
    });
    expect(offenders).toEqual([]);
  });
});
