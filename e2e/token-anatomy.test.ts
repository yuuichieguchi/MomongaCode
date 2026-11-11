import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FakeFixedUsage, FakeRoute, FakeScriptedReply } from '@momonga/testkit';
import { titleOf } from './support/cases.ts';
import { runCli } from './support/cli.ts';
import { prepareProduct } from './support/product.ts';
import { UPSTREAM_MODEL } from './support/stack.ts';
import { chatCompletions, reportedTokensOfRequest, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const COMPLETION_TOKENS = 5;
const REASONING_FIRST = 3;
const REASONING_SECOND = 4;
const CACHED_SECOND = 1024;
const PRICE = { provider: 'fake', model: UPSTREAM_MODEL, effectiveFrom: '1970-01-01', inputPerMTok: 2, cachedInputPerMTok: 0.5, outputPerMTok: 8, currency: 'USD' as const };

type Breakdown = {
  calls: number;
  layers: { estimated: boolean; shares: Record<string, number>; tokens: Record<string, number>; callsWithoutAnatomy: number };
  billed: { inputTokens: number; uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number; reasoningTokens: number };
  cacheHitRatio: number | null;
  timeToFirstToken: { median: number; p95: number; n: number } | null;
  duration: { median: number; p95: number; n: number } | null;
  cost: { amount: number | null; currency: string; unpricedCalls: number };
};

const hasToolMessage = (body: unknown): boolean => ((body as { messages?: { role: string }[] }).messages ?? []).some((message) => message.role === 'tool');

const withDetailedUsage = (reply: FakeScriptedReply, body: unknown, cached: number, reasoning: number): FakeScriptedReply => {
  const promptTokens = reportedTokensOfRequest(body);
  const usage = {
    prompt_tokens: promptTokens,
    completion_tokens: COMPLETION_TOKENS,
    total_tokens: promptTokens + COMPLETION_TOKENS,
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: reasoning },
  };
  const fixed: FakeFixedUsage = usage;
  return { ...reply, usage: fixed } as FakeScriptedReply;
};

const twoStepRoute = (fileOf: () => string): FakeRoute => ({
  match: () => true,
  reply: (body) =>
    hasToolMessage(body)
      ? withDetailedUsage(textReply('read it'), body, CACHED_SECOND, REASONING_SECOND)
      : withDetailedUsage(toolCallReply('Read', { file_path: fileOf() }, 'call_read'), body, 0, REASONING_FIRST),
});

const jsonOf = <T>(text: string): T => JSON.parse(text) as T;

describe('token anatomy end to end', () => {
  it(titleOf('cost-breakdown'), { timeout: 3 * E2E_TEST_TIMEOUT_MS }, async () => {
    let notes = '';
    const routed = await prepareProduct({ routes: [twoStepRoute(() => notes)], settings: { pricing: [PRICE] } });
    notes = path.join(routed.home.project, 'notes.txt');
    fs.writeFileSync(notes, 'token anatomy notes\n');

    const ran = await runCli(routed.home, ['-p', 'Read notes.txt', '--output-format', 'json', '--dangerously-skip-permissions']);
    expect(ran.code).toBe(0);
    const { run_id: runId, session_id: sessionId } = jsonOf<{ run_id: string; session_id: string }>(ran.stdout);
    const requests = chatCompletions(routed.fake);
    expect(requests).toHaveLength(2);
    const [first, second] = requests.map((request) => reportedTokensOfRequest(request.body)) as [number, number];
    expect(second).toBeGreaterThanOrEqual(CACHED_SECOND);
    const input = first + second;
    const uncached = input - CACHED_SECOND;
    const amount = (4 * uncached + CACHED_SECOND + 2 * (2 * COMPLETION_TOKENS * 8)) / 2_000_000;

    const runJson = await runCli(routed.home, ['cost', runId, '--breakdown', '--json']);
    expect(runJson.stderr).toBe('');
    expect(runJson.code).toBe(0);
    const forRun = jsonOf<Breakdown>(runJson.stdout);
    expect(forRun.calls).toBe(2);
    expect(forRun.billed).toEqual({
      inputTokens: input,
      reportedInputTokens: input,
      uncachedInputTokens: uncached,
      cacheReadTokens: CACHED_SECOND,
      cacheWriteTokens: 0,
      outputTokens: 2 * COMPLETION_TOKENS,
      reasoningTokens: REASONING_FIRST + REASONING_SECOND,
    });
    expect(forRun.cacheHitRatio).toBeCloseTo(CACHED_SECOND / input, 12);
    expect(forRun.cost).toEqual({ amount, currency: 'USD', unpricedCalls: 0, priceNotRecordedCalls: 0, priceVersions: ['1970-01-01'], unpriced: {} });
    expect(forRun.timeToFirstToken?.n).toBe(2);
    expect(forRun.duration?.n).toBe(2);
    expect(forRun.duration?.p95).toBeGreaterThanOrEqual(forRun.duration?.median ?? Number.POSITIVE_INFINITY);
    expect(forRun.timeToFirstToken?.median).toBeLessThanOrEqual(forRun.duration?.p95 ?? -1);
    expect(forRun.layers.estimated).toBe(true);
    expect(forRun.layers.callsWithoutAnatomy).toBe(0);
    expect(Object.values(forRun.layers.shares).reduce((sum, share) => sum + share, 0)).toBeCloseTo(1, 9);
    expect(forRun.layers.tokens['system']).toBeGreaterThan(0);
    expect(forRun.layers.tokens['tools']).toBeGreaterThan(0);
    expect(forRun.layers.tokens['history.user']).toBeGreaterThan(0);
    expect(forRun.layers.tokens['history.toolCalls']).toBeGreaterThan(0);
    expect(forRun.layers.tokens['history.toolOutputs']).toBeGreaterThan(0);

    const forSession = jsonOf<Breakdown>((await runCli(routed.home, ['cost', '--session', sessionId, '--breakdown', '--json'])).stdout);
    expect(forSession).toEqual(forRun);

    const text = await runCli(routed.home, ['cost', runId, '--breakdown']);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('calls: 2');
    expect(text.stdout).toContain(`billed tokens: input ${input}; output ${2 * COMPLETION_TOKENS} (reasoning ${REASONING_FIRST + REASONING_SECOND})`);
    expect(text.stdout).toContain(`cache split of ${input} input token(s) in 2 of 2 call(s): uncached ${uncached} + cache read ${CACHED_SECOND} + cache write 0`);
    expect(text.stdout).toContain(`cache hit ratio: ${((100 * CACHED_SECOND) / input).toFixed(1)}%`);
    expect(text.stdout).toContain(`cost: ${amount} USD`);
    expect(text.stdout).toMatch(/time to first token: median \d+ ms, p95 \d+ ms \(n=2\)/);
    expect(text.stdout).toMatch(/duration: median \d+ ms, p95 \d+ ms \(n=2\)/);
    expect(text.stdout).toMatch(/history\.toolOutputs \d+\.\d%/);
    const sessionText = await runCli(routed.home, ['cost', '--session', sessionId, '--breakdown']);
    expect(sessionText.stdout).toContain(`cache split of ${input} input token(s) in 2 of 2 call(s): uncached ${uncached}`);

    const trace = await runCli(routed.home, ['trace', runId]);
    expect(trace.code).toBe(0);
    expect(trace.stdout).toMatch(/step 1, attempt 1: \d+ tokens \(estimated\)/);
    expect(trace.stdout).toMatch(/step 2, attempt 1: \d+ tokens \(estimated\).*history\.toolOutputs \d+/);
  });
});
