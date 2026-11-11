import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { UNPRICED_CODES } from '@momonga/protocol';
import {
  UNPRICED_CODE_TEXT,
  buildCostBreakdown,
  buildCostReport,
  definePriceTable,
  formatCostBreakdown,
  formatCostReport,
  priceCall,
  recordChatResponse,
  startAgentSpan,
  startChatSpan,
} from '@momonga/observability';
import type { CallBilling, ChatBilling, PricedCall } from '@momonga/observability';
import { harness, billedCallsOfRun, moneyLine } from './helpers.ts';

const AT = Date.parse('2026-07-10T00:00:00Z');
const TABLE = definePriceTable([{ provider: 'acme', model: 'm1', effectiveFrom: '2026-01-01', inputPerMTok: 1, outputPerMTok: 4, currency: 'USD' }]);

type Kind = 'metered' | 'local' | 'plan' | 'unknown' | 'estimated' | 'cacheAbsent' | 'noEntry' | 'unpriceable';

const outcome = (kind: Kind): PricedCall => {
  const billing: CallBilling = kind === 'noEntry' || kind === 'unpriceable' || kind === 'cacheAbsent' || kind === 'estimated' ? 'metered' : kind;
  return priceCall({
    provider: 'acme',
    model: kind === 'noEntry' ? 'unlisted' : 'm1',
    billing,
    usageSource: kind === 'estimated' ? 'estimated' : 'reported',
    usage: { inputTokens: kind === 'unpriceable' ? 0.5 : 1_000_000, outputTokens: 0, ...(kind === 'cacheAbsent' ? {} : { cachedInputTokens: 0 }) },
    at: new Date(AT),
    table: TABLE,
  });
};

const mix = (...kinds: Kind[]): PricedCall[] => kinds.map(outcome);

describe('the code texts', () => {
  it('give one display text per unpriced code', () => {
    expect(UNPRICED_CODE_TEXT).toEqual({
      plan: 'plan usage, no per-token price',
      unknown_billing: 'billing unknown',
      usage_not_reported: 'usage not reported',
      cache_read_not_reported: 'cache reads not reported',
      no_price_entry: 'no price entry',
      unpriceable_usage: 'usage cannot be priced',
    });
  });
});

describe('the money line over the classes of the calls (R-B)', () => {
  it.each<[string, Kind[], string]>([
    ['no calls', [], 'no calls'],
    ['all priced', ['metered', 'metered'], '2 USD at price version 2026-01-01'],
    ['all local', ['local', 'local'], '0 USD, all 2 call(s) ran locally and cost nothing'],
    ['all plan', ['plan', 'plan'], 'not complete: plan usage, no per-token price in 2 call(s)'],
    ['all unknown billing', ['unknown'], 'not complete: billing unknown in 1 call(s)'],
    ['all without a price entry', ['noEntry', 'noEntry', 'noEntry'], 'not complete: no price entry in 3 call(s)'],
    ['plan and metered', ['plan', 'metered'], 'not complete: plan usage, no per-token price in 1 call(s); priced part: 1 USD over 1 of 2 call(s)'],
    ['plan and local', ['local', 'plan'], 'not complete: plan usage, no per-token price in 1 call(s); priced part: 0 USD over 1 of 2 call(s)'],
    ['local and no price entry', ['local', 'noEntry'], 'not complete: no price entry in 1 call(s); priced part: 0 USD over 1 of 2 call(s)'],
    ['all without a cache-read count', ['cacheAbsent', 'cacheAbsent'], 'not complete: cache reads not reported in 2 call(s)'],
    ['cache reads not reported and metered', ['metered', 'cacheAbsent'], 'not complete: cache reads not reported in 1 call(s); priced part: 1 USD over 1 of 2 call(s)'],
    ['all with an estimated usage', ['estimated', 'estimated'], 'not complete: usage not reported in 2 call(s)'],
    ['codes in the order of the list', ['unpriceable', 'noEntry', 'cacheAbsent', 'estimated', 'plan', 'unknown', 'plan'], 'not complete: plan usage, no per-token price in 2 call(s); billing unknown in 1 call(s); usage not reported in 1 call(s); cache reads not reported in 1 call(s); no price entry in 1 call(s); usage cannot be priced in 1 call(s)'],
  ])('%s', (_name, kinds, expected) => {
    expect(moneyLine(mix(...kinds))).toBe(expected);
  });
});

describe('the money line over random mixes', () => {
  const KINDS: readonly Kind[] = ['metered', 'local', 'plan', 'unknown', 'estimated', 'cacheAbsent', 'noEntry', 'unpriceable'];
  const generator = (seed: number) => {
    let state = seed >>> 0;
    return (bound: number): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % bound;
    };
  };

  it('prints a figure iff nothing is unpriced, the priced part iff both classes are present, and never a 0 USD when nothing is priced', () => {
    const next = generator(20261110);
    for (let round = 0; round < 300; round += 1) {
      const kinds = Array.from({ length: next(7) }, () => KINDS[next(KINDS.length)] as Kind);
      const n = kinds.length;
      const u = kinds.filter((kind) => kind !== 'metered' && kind !== 'local').length;
      const p = n - u;
      const line = moneyLine(mix(...kinds));
      const counted = [...line.matchAll(/ in (\d+) call\(s\)/g)].reduce((sum, match) => sum + Number(match[1]), 0);

      expect(line.startsWith('not complete: ')).toBe(u > 0);
      expect(counted).toBe(u);
      expect(line.includes('priced part: ')).toBe(p > 0 && u > 0);
      if (p > 0 && u > 0) expect(line).toContain(` over ${p} of ${n} call(s)`);
      if (u > 0 && p === 0) expect(line).not.toContain('0 USD');
      if (n === 0) expect(line).toBe('no calls');
      if (n > 0 && u === 0) expect(line).toMatch(/USD/);
    }
  });
});

describe('the report and the breakdown print the same money line for the same calls', () => {
  const record = async (runId: string, billings: readonly CallBilling[], h: ReturnType<typeof harness>): Promise<void> => {
    const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId });
    const parent = trace.setSpan(ROOT_CONTEXT, agent);
    for (const [index, billing] of billings.entries()) {
      h.clock.set(AT + index);
      const chat = startChatSpan(h.telemetry.tracer, { providerName: 'acme', billing: billing as ChatBilling, requestModel: 'm1', stream: true, runId, step: index + 1, attempt: 1 }, parent);
      recordChatResponse(chat, { finishReasons: ['stop'], usageSource: 'reported', usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 } });
      chat.end(h.clock.now());
    }
    agent.end(h.clock.now());
    await h.telemetry.forceFlush();
  };

  it.each<[string, CallBilling[]]>([
    ['all plan', ['plan', 'plan']],
    ['plan and metered', ['metered', 'plan']],
    ['unknown and local', ['local', 'unknown']],
  ])('%s', async (_name, billings) => {
    const h = harness();
    await record('run-a', billings, h);
    const calls = billedCallsOfRun(h.store, 'run-a', TABLE);
    const line = moneyLine(calls.map((call) => call.price));

    const report = formatCostReport(buildCostReport(h.store, [{ runId: 'run-a', sessionId: 's' }], { table: TABLE }));
    const breakdown = formatCostBreakdown(
      buildCostBreakdown(
        calls.map((call) => ({ runId: call.runId, provider: call.provider, model: call.model, billing: call.billing, at: new Date(call.startMs), price: call.price, usage: call.usage })),
        {},
      ),
    );

    expect(report).toContain(`  total: ${billings.length} call(s)`);
    expect(report.split('\n').find((text) => text.startsWith('  total: '))).toContain(line);
    expect(breakdown).toContain(`cost: ${line}`);
  });
});

describe('a code nobody has tested reaches every surface through the table', () => {
  it('lists a text for every code of the closed list', () => {
    expect(Object.keys(UNPRICED_CODE_TEXT).sort()).toEqual([...UNPRICED_CODES].sort());
  });
});
