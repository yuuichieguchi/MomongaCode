import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  recordChatResponse,
  recordError,
  startAgentSpan,
  startChatSpan,
  startToolSpan,
} from '@momonga/observability';
import { RUN_ID, SENTINEL, harness } from './helpers.ts';

const finished = async (h: ReturnType<typeof harness>) => {
  await h.telemetry.forceFlush();
  return h.memory.getFinishedSpans();
};

describe('startAgentSpan', () => {
  it('names, kinds and attributes the span per GenAI semconv', async () => {
    const h = harness();
    startAgentSpan(h.telemetry.tracer, {
      agentName: 'momonga',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      runId: RUN_ID,
      step: 3,
    }).end(h.clock.now());
    const [span] = await finished(h);
    expect(span?.name).toBe('invoke_agent momonga');
    expect(span?.kind).toBe(SpanKind.INTERNAL);
    expect(span?.attributes).toEqual({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'momonga',
      'gen_ai.agent.id': 'agent-1',
      'gen_ai.conversation.id': 'conv-1',
      'momonga.run_id': RUN_ID,
      'momonga.step': 3,
    });
  });

  it('omits momonga.step when no step is given', async () => {
    const h = harness();
    startAgentSpan(h.telemetry.tracer, { agentName: 'a', agentId: 'b', conversationId: 'c', runId: RUN_ID }).end(
      h.clock.now(),
    );
    const [span] = await finished(h);
    expect(span?.attributes).not.toHaveProperty('momonga.step');
  });
});

describe('startChatSpan and recordChatResponse', () => {
  it('sets request attributes, then response attributes with TTFC converted to seconds', async () => {
    const h = harness();
    const agent = startAgentSpan(h.telemetry.tracer, { agentName: 'a', agentId: 'b', conversationId: 'c', runId: RUN_ID });
    const chat = startChatSpan(
      h.telemetry.tracer,
      { providerName: 'openai', requestModel: 'gpt-x', maxTokens: 1024, stream: true, runId: RUN_ID, step: 2, attempt: 1 },
      trace.setSpan(ROOT_CONTEXT, agent),
    );
    recordChatResponse(chat, {
      responseModel: 'gpt-x-2026',
      responseId: 'resp_1',
      finishReasons: ['stop'],
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, reasoningTokens: 7 },
      timeToFirstChunkMs: 250,
    });
    chat.end(h.clock.now());
    agent.end(h.clock.now());
    const spans = await finished(h);
    const span = spans.find((candidate) => candidate.name === 'chat gpt-x');
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
    expect(span?.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-x',
      'gen_ai.request.max_tokens': 1024,
      'gen_ai.request.stream': true,
      'momonga.run_id': RUN_ID,
      'momonga.step': 2,
      'momonga.attempt': 1,
      'gen_ai.response.model': 'gpt-x-2026',
      'gen_ai.response.id': 'resp_1',
      'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 20,
      'gen_ai.usage.cache_read.input_tokens': 40,
      'gen_ai.usage.reasoning.output_tokens': 7,
      'gen_ai.response.time_to_first_chunk': 0.25,
    });
  });

  it('omits optional attributes that were not supplied', async () => {
    const h = harness();
    const chat = startChatSpan(h.telemetry.tracer, {
      providerName: 'apple',
      requestModel: 'system',
      stream: false,
      runId: RUN_ID,
      step: 1,
      attempt: 2,
    });
    recordChatResponse(chat, { finishReasons: ['length'], usage: { inputTokens: 5, outputTokens: 6 } });
    chat.end(h.clock.now());
    const [span] = await finished(h);
    expect(span?.attributes).toEqual({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'apple',
      'gen_ai.request.model': 'system',
      'gen_ai.request.stream': false,
      'momonga.run_id': RUN_ID,
      'momonga.step': 1,
      'momonga.attempt': 2,
      'gen_ai.response.finish_reasons': ['length'],
      'gen_ai.usage.input_tokens': 5,
      'gen_ai.usage.output_tokens': 6,
    });
  });
});

describe('startToolSpan', () => {
  it('names, kinds and attributes the span per GenAI semconv', async () => {
    const h = harness();
    startToolSpan(h.telemetry.tracer, {
      toolName: 'read_file',
      toolCallId: 'call_9',
      toolType: 'function',
      runId: RUN_ID,
      step: 4,
    }).end(h.clock.now());
    const [span] = await finished(h);
    expect(span?.name).toBe('execute_tool read_file');
    expect(span?.kind).toBe(SpanKind.INTERNAL);
    expect(span?.attributes).toEqual({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'read_file',
      'gen_ai.tool.call.id': 'call_9',
      'gen_ai.tool.type': 'function',
      'momonga.run_id': RUN_ID,
      'momonga.step': 4,
    });
  });
});

describe('recordError', () => {
  it('sets ERROR status and error.type and records only the class name and the safe message', async () => {
    const h = harness();
    const tool = startToolSpan(h.telemetry.tracer, {
      toolName: 'shell',
      toolCallId: 'call_1',
      toolType: 'function',
      runId: RUN_ID,
      step: 1,
    });
    recordError(tool, new TypeError(`cannot open ${SENTINEL}`), 'tool_failed', 'tool raised');
    tool.end(h.clock.now());
    const [span] = await finished(h);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.attributes['error.type']).toBe('tool_failed');
    expect(span?.events.map((event) => [event.name, event.attributes])).toEqual([
      ['exception', { 'exception.type': 'TypeError', 'exception.message': 'tool raised' }],
    ]);
    expect(JSON.stringify({ status: span?.status, attributes: span?.attributes, events: span?.events })).not.toContain(
      SENTINEL,
    );
  });

  it('records no exception.message when no safe message is supplied', async () => {
    const h = harness();
    const chat = startChatSpan(h.telemetry.tracer, {
      providerName: 'openai',
      requestModel: 'gpt-x',
      stream: false,
      runId: RUN_ID,
      step: 1,
      attempt: 1,
    });
    recordError(chat, new RangeError(SENTINEL), 'timeout');
    chat.end(h.clock.now());
    const [span] = await finished(h);
    expect(span?.attributes['error.type']).toBe('timeout');
    expect(span?.events.map((event) => event.attributes)).toEqual([{ 'exception.type': 'RangeError' }]);
    expect(JSON.stringify({ status: span?.status, events: span?.events })).not.toContain(SENTINEL);
  });

  it('names a null-prototype throwable and a thrown string without throwing', async () => {
    const h = harness();
    const first = startToolSpan(h.telemetry.tracer, { toolName: 'a', toolCallId: '1', toolType: 'function', runId: RUN_ID, step: 1 });
    const second = startToolSpan(h.telemetry.tracer, { toolName: 'b', toolCallId: '2', toolType: 'function', runId: RUN_ID, step: 1 });
    expect(() => recordError(first, Object.create(null), 'tool_failed')).not.toThrow();
    expect(() => recordError(second, SENTINEL, 'tool_failed')).not.toThrow();
    first.end(h.clock.now());
    second.end(h.clock.now());
    const spans = await finished(h);
    const types = spans.map((span) => [span.name, span.events.map((event) => event.attributes?.['exception.type'])]);
    expect(types).toEqual([
      ['execute_tool a', ['object']],
      ['execute_tool b', ['string']],
    ]);
    expect(JSON.stringify(spans.map((span) => span.events))).not.toContain(SENTINEL);
  });
});
