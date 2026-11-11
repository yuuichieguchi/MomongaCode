import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemClock, BUSY_WAIT_LIMIT_MS } from '@momonga/foundation';
import { GENAI_SEMCONV, buildCostReport, definePriceTable, formatCostReport, openTraceStore } from '@momonga/observability';
import { OTLP_SPAN_KIND, decodeOtlpSpans, modelSettings, startOtlpCollector } from '@momonga/testkit';
import type { DecodedOtlpSpan, OtlpCollector } from '@momonga/testkit';
import { titleOf } from './support/cases.ts';
import { createE2eHome, registerE2eCleanup } from './support/home.ts';
import { createRuntimeClient } from './support/runtime-client.ts';
import { shutdownBarrier, startStack } from './support/stack.ts';
import { UPSTREAM_MODEL } from './support/stack.ts';
import { chatCompletions, reportedTokensOfRequest, textReply, toolCallReply } from './support/upstream.ts';
import { E2E_RUN_COMPLETED_BOUND_MS, E2E_TEST_TIMEOUT_MS } from './support/wait.ts';

const startCollector = async (): Promise<OtlpCollector> => {
  const collector = await startOtlpCollector();
  registerE2eCleanup(() => collector.close());
  return collector;
};

const runReadTask = async (settings: Readonly<Record<string, unknown>>) => {
  const home = await createE2eHome();
  const file = path.join(home.project, 'notes.txt');
  fs.writeFileSync(file, 'otlp notes\n');
  const stack = await startStack({
    home,
    script: [toolCallReply('Read', { file_path: file }), textReply('read it')],
    settings,
  });
  const runtime = createRuntimeClient(home);
  try {
    const { session } = await runtime.createSession();
    const { run } = await runtime.createRun(session.id, 'Read notes.txt');
    const stream = runtime.events(run.id);
    await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
    await stream.close();
    expect((await runtime.getRun(run.id)).run.status).toBe('COMPLETED');
    expect(chatCompletions(stack.fake)).toHaveLength(2);
    return { stack, runId: run.id, sessionId: session.id };
  } finally {
    await runtime.close();
  }
};

const only = (spans: readonly DecodedOtlpSpan[], predicate: (span: DecodedOtlpSpan) => boolean, description: string): DecodedOtlpSpan => {
  const found = spans.filter(predicate);
  if (found.length !== 1) throw new Error(`expected exactly one ${description}, found ${found.length}`);
  return found[0] as DecodedOtlpSpan;
};

describe('OTLP export through real processes', () => {
  it(titleOf('otlp-export'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const collector = await startCollector();
    const { stack, runId, sessionId } = await runReadTask({ telemetry: { otlp: { endpoint: collector.endpoint, headers: { 'x-eval': 'e2e' } } } });
    await shutdownBarrier(stack);

    expect(collector.requests.length).toBeGreaterThan(0);
    for (const request of collector.requests) {
      expect(request.headers['x-eval']).toBe('e2e');
      expect(request.headers['content-type']).toMatch(/^application\/json/);
    }
    const spans = decodeOtlpSpans(collector.requests);
    expect(new Set(spans.map((span) => span.service))).toEqual(new Set(['momonga-gateway', 'momonga-runtime']));
    expect(new Set(spans.map((span) => span.scopeSchemaUrl))).toEqual(new Set([GENAI_SEMCONV.schemaUrl]));

    const agent = only(spans, (span) => span.name === 'invoke_agent momonga', 'invoke_agent span');
    const tool = only(spans, (span) => span.name === 'execute_tool Read', 'execute_tool span');
    const chats = spans.filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
    expect(chats).toHaveLength(2);

    expect(agent.service).toBe('momonga-runtime');
    expect(agent.kind).toBe(OTLP_SPAN_KIND.INTERNAL);
    expect(agent.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'momonga',
      'gen_ai.conversation.id': sessionId,
      'momonga.run_id': runId,
    });
    expect(tool.parentSpanId).toBe(agent.spanId);
    expect(tool.attributes).toMatchObject({ 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'Read', 'gen_ai.tool.type': 'function', 'momonga.run_id': runId });

    const reportedInputs = chatCompletions(stack.fake).map((request) => reportedTokensOfRequest(request.body));
    expect(chats.map((chat) => chat.attributes['gen_ai.usage.input_tokens']).sort()).toEqual([...reportedInputs].sort());
    for (const chat of chats) {
      expect(chat.service).toBe('momonga-gateway');
      expect(chat.kind).toBe(OTLP_SPAN_KIND.CLIENT);
      expect(chat.traceId).toBe(agent.traceId);
      expect(chat.parentSpanId).toBe(agent.spanId);
      expect(chat.name).toBe('chat system');
      expect(chat.attributes).toMatchObject({ 'gen_ai.request.model': 'system', 'gen_ai.response.finish_reasons': expect.any(Array), 'momonga.run_id': runId });
      expect(chat.attributes['gen_ai.provider.name']).toBe('fake');
      expect(chat.attributes['gen_ai.usage.output_tokens']).toBe(5);
    }
    expect(JSON.stringify(collector.requests.map((request) => request.body))).not.toContain('otlp notes');
  });

  const UPSTREAM_PRICES = [{ provider: 'apple', model: UPSTREAM_MODEL, effectiveFrom: '1970-01-01', inputPerMTok: 0, outputPerMTok: 0, currency: 'USD' as const }];

  it(titleOf('cost-report'), { timeout: E2E_TEST_TIMEOUT_MS }, async () => {
    const home = await createE2eHome();
    const file = path.join(home.project, 'notes.txt');
    fs.writeFileSync(file, 'cost notes\n');
    const stack = await startStack({
      home,
      script: [toolCallReply('Read', { file_path: file }), textReply('read it')],
      settings: {
        ...modelSettings({
          models: [{ adapter: 'chat-completions', provider: 'apple', id: UPSTREAM_MODEL, socketPath: home.upstreamSocket, capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } }],
        }),
        pricing: UPSTREAM_PRICES,
      },
    });
    const runtime = createRuntimeClient(home);
    let runId: string;
    let sessionId: string;
    try {
      const { session } = await runtime.createSession();
      sessionId = session.id;
      runId = (await runtime.createRun(session.id, 'Read notes.txt')).run.id;
      const stream = runtime.events(runId);
      await stream.toEnd(E2E_RUN_COMPLETED_BOUND_MS);
      await stream.close();
    } finally {
      await runtime.close();
    }
    await shutdownBarrier(stack);

    const store = openTraceStore({ busyTimeoutMs: BUSY_WAIT_LIMIT_MS, path: home.paths.traces.gateway, clock: systemClock });
    try {
      const report = buildCostReport(store, [{ runId, sessionId }], { table: definePriceTable(UPSTREAM_PRICES) });
      console.log(formatCostReport(report));
      expect(report.runs).toHaveLength(1);
      expect(report.sessions).toMatchObject([{ sessionId, runIds: [runId], calls: 2 }]);
      expect(report.total).toMatchObject({
        calls: 2,
        unpricedCalls: 0,
        inputTokens: chatCompletions(stack.fake).reduce((sum, request) => sum + reportedTokensOfRequest(request.body), 0),
        outputTokens: 10,
        cachedInputTokens: 0,
        amount: 0,
        currency: 'USD',
        priceVersions: ['1970-01-01'],
      });
    } finally {
      store.close();
    }
  });
});
