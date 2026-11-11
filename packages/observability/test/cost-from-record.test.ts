import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { buildCostReport, callPriceOf, formatCostReport, pageBilledCalls, recordChatResponse, startAgentSpan, startChatSpan } from '@momonga/observability';
import type { PricedBilledCall } from '@momonga/observability';
import type { RecordedPrice } from '@momonga/protocol';
import { harness } from './helpers.ts';

const AT = Date.parse('2026-03-10T00:00:00Z');
const RUN = { runId: 'run-a', sessionId: 'session-1' };
const TWO_USD: RecordedPrice = { kind: 'priced', cost: { amount: 2, units: '2000000000000000', currency: 'USD', priceVersion: '2026-01-01' } };

const recordCall = async (h: ReturnType<typeof harness>, responseId: string): Promise<void> => {
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 's', runId: RUN.runId });
  h.clock.set(AT);
  const chat = startChatSpan(h.telemetry.tracer, { providerName: 'acme', billing: 'metered', requestModel: 'm1', stream: true, runId: RUN.runId, step: 1, attempt: 1 }, trace.setSpan(ROOT_CONTEXT, agent));
  recordChatResponse(chat, { responseId, finishReasons: ['stop'], usageSource: 'reported', usage: { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 0 } });
  chat.end(h.clock.now());
  agent.end(h.clock.now());
  await h.telemetry.forceFlush();
};

const pricedBy = (h: ReturnType<typeof harness>, recorded: ReadonlyMap<string, RecordedPrice>): PricedBilledCall[] =>
  pageBilledCalls(h.store, [RUN.runId], { run: 0, after: 0 }, 10, false).calls.map((call) => ({
    ...call,
    price: callPriceOf((call.responseId === undefined ? undefined : recorded.get(call.responseId)) ?? { kind: 'not_recorded' }),
  }));

describe('the cost report reads the recorded cost of a call', () => {
  it('reports a call recorded at 2 USD as 2 USD with its recorded price version, whatever the price table says today', async () => {
    const h = harness();
    await recordCall(h, 'resp_1');

    const report = buildCostReport(pricedBy(h, new Map([['resp_1', TWO_USD]])), [RUN]);

    expect(report.total).toMatchObject({ calls: 1, amount: 2, priceVersions: ['2026-01-01'], priceNotRecordedCalls: 0 });
    expect(formatCostReport(report)).toContain('2 USD at price version 2026-01-01');
  });

  it('carries no price on a billed call of the trace: the span holds tokens only', async () => {
    const h = harness();
    await recordCall(h, 'resp_1');

    const [call] = pageBilledCalls(h.store, [RUN.runId], { run: 0, after: 0 }, 10, false).calls;

    expect(call).toMatchObject({ runId: RUN.runId, responseId: 'resp_1', usage: { inputTokens: 1_000_000 } });
    expect(call).not.toHaveProperty('price');
  });

  it('counts a call that has no cost record as price not recorded and never prices it', async () => {
    const h = harness();
    await recordCall(h, 'resp_1');

    const report = buildCostReport(pricedBy(h, new Map()), [RUN]);

    expect(report.total).toMatchObject({ calls: 1, amount: null, priceNotRecordedCalls: 1, inputTokens: 1_000_000 });
  });

  it('reads the units of a recorded cost exactly, and the amount of a record written before units', () => {
    expect(callPriceOf(TWO_USD)).toEqual({ kind: 'priced', units: 2_000_000_000_000_000n, currency: 'USD', priceVersion: '2026-01-01' });
    expect(callPriceOf({ kind: 'priced', cost: { amount: 0.000062, currency: 'USD', priceVersion: '2026-01-01' } })).toMatchObject({ kind: 'priced', units: 62_000_000_000n });
    expect(callPriceOf({ kind: 'unpriced', code: 'plan', reason: 'plan' })).toEqual({ kind: 'unpriced', code: 'plan', reason: 'plan' });
  });
});

const SOURCE_ROOT = path.resolve(import.meta.dirname, '../..');
const THE_ONE_COMPUTATION = ['gateway/src/core/model-cost.ts', 'observability/src/cost.ts', 'observability/src/index.ts'];

const sourceFilesOf = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesOf(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.generated.ts') ? [full] : [];
  });

describe('a past call is never priced again', () => {
  it('names priceCall only in the computation of the gateway at call time', () => {
    const packages = fs.readdirSync(SOURCE_ROOT).filter((name) => fs.existsSync(path.join(SOURCE_ROOT, name, 'src')));
    const callers = packages
      .flatMap((name) => sourceFilesOf(path.join(SOURCE_ROOT, name, 'src')))
      .filter((file) => /\bpriceCall\b/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SOURCE_ROOT, file).split(path.sep).join('/'));
    expect(callers.sort()).toEqual([...THE_ONE_COMPUTATION].sort());
  });

  it('keeps no usage table and no usage route in the gateway', () => {
    const gateway = sourceFilesOf(path.join(SOURCE_ROOT, 'gateway', 'src')).map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    expect(gateway).not.toMatch(/INTO usage\b/);
    expect(gateway).not.toMatch(/FROM usage\b/);
    expect(gateway).not.toContain('/v1/momonga/usage');
  });
});
