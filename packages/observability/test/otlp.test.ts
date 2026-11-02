import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import {
  GENAI_SEMCONV,
  OTLP_EXPORTS_PER_TEARDOWN,
  OTLP_EXPORT_TIMEOUT_MS,
  OTLP_TEARDOWN_SHARE,
  createOtlpTraceExporter,
  exportersFor,
  installOtelErrorHandler,
  otlpTracesUrl,
  recordChatResponse,
  startAgentSpan,
  startChatSpan,
  startToolSpan,
} from '@momonga/observability';
import { RUNTIME_TEARDOWN_BUDGET_MS } from '@momonga/foundation';
import { OTLP_SPAN_KIND, decodeOtlpSpans, startOtlpCollector } from '@momonga/testkit';
import type { OtlpCollector } from '@momonga/testkit';
import { RUN_ID, SENTINEL, harness, registerCleanup } from './helpers.ts';

const UNREACHABLE_EXPORT_TIMEOUT_MS = 300;

const fixture = (collector: OtlpCollector, headers?: Record<string, string>, timeoutMs?: number) =>
  harness({
    exporters: [createOtlpTraceExporter({ endpoint: collector.endpoint, ...(headers === undefined ? {} : { headers }) }, timeoutMs === undefined ? {} : { timeoutMs })],
  });

const recordRun = (h: ReturnType<typeof harness>) => {
  const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'momonga', agentId: 'momonga', conversationId: 'session-1', runId: RUN_ID });
  const agentContext = trace.setSpan(ROOT_CONTEXT, agent);
  const chat = startChatSpan(
    h.telemetry.tracer,
    { providerName: 'openai', billing: 'metered', requestModel: 'model-x', maxTokens: 512, stream: true, runId: RUN_ID, step: 1, attempt: 1 },
    agentContext,
  );
  recordChatResponse(chat, { responseModel: 'model-x', responseId: 'resp_1', finishReasons: ['tool_calls'], usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 } });
  chat.end(h.clock.now());
  const tool = startToolSpan(h.telemetry.tracer, { toolName: 'Read', toolCallId: 'call_1', toolType: 'function', runId: RUN_ID, step: 1 }, agentContext);
  tool.end(h.clock.now());
  agent.end(h.clock.now());
  return { agent, chat, tool };
};

describe('OTLP export of GenAI spans to a loopback collector', () => {
  it('delivers one OTLP/JSON request whose resource, scope, schema URL and spans follow the pinned semconv', async () => {
    const collector = await startOtlpCollector();
    registerCleanup(() => collector.close());
    const h = fixture(collector);
    const { agent, chat, tool } = recordRun(h);
    await h.telemetry.forceFlush();

    expect(collector.requests).toHaveLength(1);
    const [request] = collector.requests;
    if (request === undefined) throw new Error('no request');
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/v1/traces');
    expect(request.headers['content-type']).toMatch(/^application\/json/);

    const spans = decodeOtlpSpans(collector.requests);
    expect(new Set(spans.map((span) => span.service))).toEqual(new Set(['momonga-test']));
    expect(new Set(spans.map((span) => span.scope))).toEqual(new Set(['@momonga/observability']));
    expect(new Set(spans.map((span) => span.scopeSchemaUrl))).toEqual(new Set([GENAI_SEMCONV.schemaUrl]));
    expect(GENAI_SEMCONV.schemaUrl).toBe(`https://opentelemetry.io/schemas/${GENAI_SEMCONV.npmVersion}`);
    expect(spans.map((span) => span.name).sort()).toEqual(['chat model-x', 'execute_tool Read', 'invoke_agent momonga']);
    for (const span of spans) {
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(span.endNano).toBeGreaterThanOrEqual(span.startNano);
    }
    const [agentSpan, chatSpan, toolSpan] = ['invoke_agent momonga', 'chat model-x', 'execute_tool Read'].map((name) => {
      const found = spans.find((span) => span.name === name);
      if (found === undefined) throw new Error(`no span named ${name}`);
      return found;
    }) as [(typeof spans)[number], (typeof spans)[number], (typeof spans)[number]];
    expect(agentSpan.parentSpanId).toBe('');
    expect(chatSpan.parentSpanId).toBe(agentSpan.spanId);
    expect(toolSpan.parentSpanId).toBe(agentSpan.spanId);
    expect(chatSpan.traceId).toBe(agentSpan.traceId);
    expect(agent.spanContext().spanId).toBe(agentSpan.spanId);
    expect(chat.spanContext().spanId).toBe(chatSpan.spanId);
    expect(tool.spanContext().spanId).toBe(toolSpan.spanId);

    expect(agentSpan.kind).toBe(OTLP_SPAN_KIND.INTERNAL);
    expect(chatSpan.kind).toBe(OTLP_SPAN_KIND.CLIENT);
    expect(toolSpan.kind).toBe(OTLP_SPAN_KIND.INTERNAL);
    expect(agentSpan.attributes).toEqual({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'momonga',
      'gen_ai.agent.id': 'momonga',
      'gen_ai.conversation.id': 'session-1',
      'momonga.run_id': RUN_ID,
    });
    expect(chatSpan.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'model-x',
      'gen_ai.request.max_tokens': 512,
      'gen_ai.request.stream': true,
      'gen_ai.response.model': 'model-x',
      'gen_ai.response.id': 'resp_1',
      'gen_ai.response.finish_reasons': ['tool_calls'],
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.cache_read.input_tokens': 40,
      'momonga.run_id': RUN_ID,
      'momonga.step': 1,
      'momonga.attempt': 1,
      'momonga.billing': 'metered',
    });
    expect(toolSpan.attributes).toEqual({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'Read',
      'gen_ai.tool.call.id': 'call_1',
      'gen_ai.tool.type': 'function',
      'momonga.run_id': RUN_ID,
      'momonga.step': 1,
    });
  });

  it('sends the configured headers', async () => {
    const collector = await startOtlpCollector();
    registerCleanup(() => collector.close());
    const h = fixture(collector, { 'x-team': 'eval' });
    recordRun(h);
    await h.telemetry.forceFlush();
    expect(collector.requests[0]?.headers['x-team']).toBe('eval');
  });

  it('never exports message content: captured bodies, tool arguments and results stay out of the payload', async () => {
    const collector = await startOtlpCollector();
    registerCleanup(() => collector.close());
    const h = harness({
      bodies: { enabled: true, retentionMs: 60_000 },
      exporters: [createOtlpTraceExporter({ endpoint: collector.endpoint })],
    });
    const { chat, tool } = recordRun(h);
    h.telemetry.recordBody(chat, { kind: 'input', content: `prompt ${SENTINEL}` });
    h.telemetry.recordBody(chat, { kind: 'output', content: `answer ${SENTINEL}` });
    h.telemetry.recordBody(tool, { kind: 'tool_arguments', content: `{"file_path":"${SENTINEL}"}` });
    h.telemetry.recordBody(tool, { kind: 'tool_result', content: SENTINEL });
    await h.telemetry.forceFlush();

    expect(collector.requests).toHaveLength(1);
    const raw = collector.requests[0]?.raw ?? '';
    expect(raw).not.toContain(SENTINEL);
    const keys = decodeOtlpSpans(collector.requests).flatMap((span) => Object.keys(span.attributes));
    for (const optIn of ['gen_ai.input.messages', 'gen_ai.output.messages', 'gen_ai.system_instructions', 'gen_ai.tool.definitions', 'gen_ai.tool.call.arguments', 'gen_ai.tool.call.result']) {
      expect(keys).not.toContain(optIn);
    }
  });
});

describe('failure isolation of the OTLP exporter', () => {
  const reported: Error[] = [];
  beforeAll(() => {
    installOtelErrorHandler((error) => void reported.push(error));
  });
  afterAll(() => {
    installOtelErrorHandler(() => undefined);
  });

  it('keeps instrumented code, flush and shutdown free of the collector failure and reports it to the error handler', async () => {
    const collector = await startOtlpCollector();
    registerCleanup(() => collector.close());
    collector.respondWith({ status: 400, body: '{"message":"rejected"}' });
    const h = fixture(collector);
    expect(() => recordRun(h)).not.toThrow();
    await expect(h.telemetry.forceFlush()).resolves.toBeUndefined();
    expect(collector.requests).toHaveLength(1);
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.map((error) => error.message)).toContain('OTLPExporterError: Bad Request');
    await expect(h.telemetry.shutdown()).resolves.toBeUndefined();
  });

  it('keeps the caller free of an unreachable collector', async () => {
    const collector = await startOtlpCollector();
    const h = fixture(collector, undefined, UNREACHABLE_EXPORT_TIMEOUT_MS);
    await collector.close();
    const before = reported.length;
    expect(() => recordRun(h)).not.toThrow();
    await expect(h.telemetry.forceFlush()).resolves.toBeUndefined();
    expect(reported.length).toBeGreaterThan(before);
    expect(reported.slice(before).map((error) => error.message).join('\n')).toMatch(/ECONNREFUSED|fetch failed|connect/i);
  });

  it('bounds flush and shutdown by the export timeout when the collector accepts the connection and never answers', async () => {
    const collector = await startOtlpCollector();
    registerCleanup(() => collector.close());
    collector.respondWith({ hang: true });
    const h = fixture(collector, undefined, UNREACHABLE_EXPORT_TIMEOUT_MS);
    const before = reported.length;
    expect(() => recordRun(h)).not.toThrow();
    await expect(h.telemetry.forceFlush()).resolves.toBeUndefined();
    await expect(h.telemetry.shutdown()).resolves.toBeUndefined();
    expect(collector.requests.length).toBeGreaterThan(0);
    expect(reported.length).toBeGreaterThan(before);
  });

  it('still writes the local trace store when the collector rejects the export', async () => {
    const collector = await startOtlpCollector();
    registerCleanup(() => collector.close());
    collector.respondWith({ status: 400 });
    const h = fixture(collector);
    recordRun(h);
    await h.telemetry.forceFlush();
    expect(h.store.spansForRun(RUN_ID).map((span) => span.name).sort()).toEqual(['chat model-x', 'execute_tool Read', 'invoke_agent momonga']);
  });
});

describe('OTLP exporter configuration', () => {
  it('appends the traces path to the endpoint', () => {
    expect(otlpTracesUrl('http://127.0.0.1:4318')).toBe('http://127.0.0.1:4318/v1/traces');
    expect(otlpTracesUrl('https://collector.example/prefix/')).toBe('https://collector.example/prefix/v1/traces');
    expect(otlpTracesUrl('https://collector.example/prefix')).toBe('https://collector.example/prefix/v1/traces');
  });

  it('refuses an endpoint that is not http or https', () => {
    expect(() => otlpTracesUrl('file:///tmp/x')).toThrow(TypeError);
    expect(() => otlpTracesUrl('not a url')).toThrow();
    expect(() => otlpTracesUrl('http://collector.example')).toThrow(/must use https/);
    expect(() => otlpTracesUrl('https://user:hunter2@collector.example')).toThrow('must not contain userinfo');
    expect(() => otlpTracesUrl('https://user:hunter2@collector.example')).not.toThrow(/hunter2/);
  });

  it('lets the flush and the shutdown export together take at most half of the runtime teardown budget', () => {
    expect(OTLP_EXPORT_TIMEOUT_MS * OTLP_EXPORTS_PER_TEARDOWN).toBe(RUNTIME_TEARDOWN_BUDGET_MS * OTLP_TEARDOWN_SHARE);
    expect(OTLP_EXPORT_TIMEOUT_MS * OTLP_EXPORTS_PER_TEARDOWN).toBeLessThan(RUNTIME_TEARDOWN_BUDGET_MS);
    expect(OTLP_EXPORT_TIMEOUT_MS).toBe(2500);
  });

  it('exports nothing unless telemetry settings name an OTLP endpoint', () => {
    expect(exportersFor(undefined)).toEqual([]);
    expect(exportersFor({})).toEqual([]);
    expect(exportersFor({ otlp: { endpoint: 'http://127.0.0.1:4318' } })).toHaveLength(1);
  });

  it('exports only when the batch is flushed', async () => {
    const collector = await startOtlpCollector();
    registerCleanup(() => collector.close());
    const h = fixture(collector);
    recordRun(h);
    expect(collector.requests).toHaveLength(0);
    await h.telemetry.forceFlush();
    expect(collector.requests).toHaveLength(1);
  });
});
