import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import {
  openTraceStore,
  recordChatResponse,
  recordError,
  startAgentSpan,
  startChatSpan,
  startToolSpan,
} from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import { CONTENT, RUN_ID, SENTINEL, START_MS, dumpAllRows, harness, makeDir, openStore, bodiesOfSpan } from './helpers.ts';

describe('openTraceStore', () => {
  it('creates the database file with mode 0600 in a 0700 directory', () => {
    const { file } = openStore(createFakeClock(START_MS));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses a directory that is not 0700', () => {
    const dir = makeDir(0o755);
    expect(() => openTraceStore({ path: path.join(dir, 'traces.db'), clock: createFakeClock(START_MS) })).toThrow(/0700/);
  });

  it('indexes spans by run_id', () => {
    const { store, file } = openStore(createFakeClock(START_MS));
    store.close();
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const indexes = db.prepare("PRAGMA index_list('spans')").all() as Array<{ name: string }>;
      const indexed = indexes.flatMap((index) =>
        (db.prepare(`PRAGMA index_info('${index.name}')`).all() as Array<{ name: string }>).map((column) => column.name),
      );
      expect(indexed).toContain('run_id');
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
        (table) => table.name,
      );
      expect(tables).toEqual(expect.arrayContaining(['spans', 'bodies']));
    } finally {
      db.close();
    }
  });

  it('close is idempotent and reopening keeps the data', async () => {
    const h = harness();
    startAgentSpan(h.telemetry.tracer, { agentName: 'a', agentId: 'b', conversationId: 'c', runId: RUN_ID }).end(
      h.clock.now(),
    );
    await h.telemetry.forceFlush();
    h.store.close();
    expect(() => h.store.close()).not.toThrow();
    const reopened = openTraceStore({ path: h.file, clock: h.clock });
    try {
      expect(reopened.spansForRun(RUN_ID)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});

describe('stored spans', () => {
  it('spansForRun returns full records ordered by start time', async () => {
    const h = harness();
    const agent = startAgentSpan(h.telemetry.tracer, {
      agentName: 'momonga',
      agentId: 'agent-1',
      conversationId: 'conv-1',
      runId: RUN_ID,
    });
    const parent = trace.setSpan(ROOT_CONTEXT, agent);
    h.clock.advance(10);
    const chat = startChatSpan(
      h.telemetry.tracer,
      { providerName: 'openai', billing: 'metered', requestModel: 'gpt-x', stream: false, runId: RUN_ID, step: 1, attempt: 1 },
      parent,
    );
    h.clock.advance(5);
    recordChatResponse(chat, { finishReasons: ['tool_calls'], usageSource: 'reported', usage: { inputTokens: 3, outputTokens: 4 } });
    chat.end(h.clock.now());
    h.clock.advance(1);
    const tool = startToolSpan(
      h.telemetry.tracer,
      { toolName: 'shell', toolCallId: 'call_1', toolType: 'function', runId: RUN_ID, step: 1 },
      parent,
    );
    h.clock.advance(2);
    recordError(tool, new Error('boom'), 'tool_failed', 'tool raised');
    tool.end(h.clock.now());
    h.clock.advance(3);
    agent.end(h.clock.now());
    startAgentSpan(h.telemetry.tracer, { agentName: 'x', agentId: 'y', conversationId: 'z', runId: 'other-run' }).end(
      h.clock.now(),
    );
    await h.telemetry.forceFlush();

    const traceId = agent.spanContext().traceId;
    const stored = h.store.spansForRun(RUN_ID);
    expect(stored.map((span) => span.name)).toEqual(['invoke_agent momonga', 'chat gpt-x', 'execute_tool shell']);
    expect(stored[0]).toEqual({
      traceId,
      spanId: agent.spanContext().spanId,
      parentSpanId: null,
      name: 'invoke_agent momonga',
      kind: 'INTERNAL',
      startMs: START_MS,
      endMs: START_MS + 21,
      status: 'UNSET',
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'momonga',
        'gen_ai.agent.id': 'agent-1',
        'gen_ai.conversation.id': 'conv-1',
        'momonga.run_id': RUN_ID,
      },
      events: [],
      runId: RUN_ID,
    });
    expect(stored[1]).toMatchObject({
      traceId,
      spanId: chat.spanContext().spanId,
      parentSpanId: agent.spanContext().spanId,
      kind: 'CLIENT',
      startMs: START_MS + 10,
      endMs: START_MS + 15,
      status: 'UNSET',
      attributes: { 'gen_ai.response.finish_reasons': ['tool_calls'], 'gen_ai.usage.input_tokens': 3 },
    });
    expect(stored[2]).toMatchObject({
      parentSpanId: agent.spanContext().spanId,
      startMs: START_MS + 16,
      endMs: START_MS + 18,
      status: 'ERROR',
      attributes: { 'error.type': 'tool_failed' },
      events: [
        { name: 'exception', timeMs: START_MS + 18, attributes: { 'exception.type': 'Error', 'exception.message': 'tool raised' } },
      ],
    });
    expect(h.store.spansForRun('missing')).toEqual([]);
  });
});

describe('body capture', () => {
  const chatSpanOf = (h: ReturnType<typeof harness>) =>
    startChatSpan(h.telemetry.tracer, {
      providerName: 'openai',
      billing: 'metered',
      requestModel: 'gpt-x',
      stream: false,
      runId: RUN_ID,
      step: 1,
      attempt: 1,
    });

  it('stores nothing anywhere by default', async () => {
    const h = harness();
    const chat = chatSpanOf(h);
    recordError(chat, new Error(SENTINEL), 'provider_error');
    chat.end(h.clock.now());
    await h.telemetry.forceFlush();
    expect(h.store.spansForRun(RUN_ID)).toHaveLength(1);
    expect(bodiesOfSpan(h.store, chat.spanContext().spanId)).toEqual([]);
    await h.telemetry.shutdown();
    h.store.close();
    expect(dumpAllRows(h.file)).not.toContain(SENTINEL);
    expect(dumpAllRows(h.file)).toContain('chat gpt-x');
  });

  it('when enabled, stores content in the bodies table and never as span attributes', async () => {
    const h = harness({ content: { retentionMs: 1000 } });
    const chat = chatSpanOf(h);
    chat.setAttribute(CONTENT.ATTR_GEN_AI_INPUT_MESSAGES, `prompt ${SENTINEL}`);
    h.clock.advance(5);
    chat.setAttribute(CONTENT.ATTR_GEN_AI_OUTPUT_MESSAGES, 'answer');
    chat.end(h.clock.now());
    await h.telemetry.forceFlush();
    const [stored] = h.store.spansForRun(RUN_ID);
    expect(JSON.stringify(stored)).not.toContain(SENTINEL);
    const [finished] = h.memory.getFinishedSpans();
    expect(finished?.attributes[CONTENT.ATTR_GEN_AI_INPUT_MESSAGES]).toBe(`prompt ${SENTINEL}`);
    expect(bodiesOfSpan(h.store, chat.spanContext().spanId)).toEqual([
      {
        traceId: chat.spanContext().traceId,
        spanId: chat.spanContext().spanId,
        kind: CONTENT.ATTR_GEN_AI_INPUT_MESSAGES,
        content: `prompt ${SENTINEL}`,
        createdAtMs: START_MS + 5,
        expiresAtMs: START_MS + 1005,
      },
      {
        traceId: chat.spanContext().traceId,
        spanId: chat.spanContext().spanId,
        kind: CONTENT.ATTR_GEN_AI_OUTPUT_MESSAGES,
        content: 'answer',
        createdAtMs: START_MS + 5,
        expiresAtMs: START_MS + 1005,
      },
    ]);
  });

  it('purgeBodies removes exactly the bodies whose retention has elapsed', async () => {
    const h = harness({ content: { retentionMs: 1000 } });
    const first = chatSpanOf(h);
    first.setAttribute(CONTENT.ATTR_GEN_AI_INPUT_MESSAGES, SENTINEL);
    first.end(h.clock.now());
    h.clock.advance(10);
    const second = chatSpanOf(h);
    second.setAttribute(CONTENT.ATTR_GEN_AI_OUTPUT_MESSAGES, 'later');
    second.end(h.clock.now());
    await h.telemetry.forceFlush();
    expect(h.store.purgeBodies(START_MS + 999)).toBe(0);
    expect(h.store.purgeBodies(START_MS + 1000)).toBe(1);
    expect(bodiesOfSpan(h.store, first.spanContext().spanId)).toEqual([]);
    expect(bodiesOfSpan(h.store, second.spanContext().spanId).map((body) => body.content)).toEqual(['later']);
    expect(h.store.purgeBodies(START_MS + 1010)).toBe(1);
    expect(bodiesOfSpan(h.store, second.spanContext().spanId)).toEqual([]);
    await h.telemetry.shutdown();
    h.store.close();
    expect(dumpAllRows(h.file)).not.toContain(SENTINEL);
  });
});
