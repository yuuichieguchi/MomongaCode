import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { createTelemetry, openTraceStore } from '@momonga/observability';
import { createFakeClock } from '@momonga/testkit';
import { GatewayRequestError } from '../../src/gateway-client.ts';
import { createTracerPort } from '../../src/tracer.ts';
import { LeaseLostError, ShutdownError } from '../../src/worker/errors.ts';

const START_MS = 1_800_000_000_000;
const QUIET_BATCH = { maxQueueSize: 2048, scheduledDelayMs: 60_000, maxExportBatchSize: 512 };
const AGENT = { runId: 'run-0001', sessionId: 'session-0001', attempt: 3 };
const TOOL = { runId: 'run-0001', step: 2, callId: 'call_1', toolName: 'Bash', toolType: 'function' };

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const setup = (captureMessageContent?: boolean) => {
  const clock = createFakeClock(START_MS);
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tr-'));
  fs.chmodSync(dir, 0o700);
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openTraceStore({ path: path.join(dir, 'traces.db'), clock });
  cleanups.push(() => store.close());
  const memory = new InMemorySpanExporter();
  const telemetry = createTelemetry({ serviceName: 'momonga-test', serviceVersion: '9.9.9', clock, store, exporters: [memory], batch: QUIET_BATCH, ...(captureMessageContent === undefined ? {} : { captureMessageContent, contentRetentionMs: 60_000 }) });
  cleanups.push(() => telemetry.shutdown());
  const tracer = createTracerPort(telemetry);
  const finished = async (): Promise<ReadableSpan[]> => {
    await telemetry.forceFlush();
    return memory.getFinishedSpans();
  };
  return { tracer, finished };
};

const gatewayError = () =>
  new GatewayRequestError({ status: 503, type: 'server_error', code: 'gateway_closed', message: 'the gateway is closing' });

const onlySpan = async (finished: () => Promise<ReadableSpan[]>): Promise<ReadableSpan> => {
  const spans = await finished();
  expect(spans).toHaveLength(1);
  const [span] = spans;
  if (span === undefined) throw new Error('expected one finished span');
  return span;
};

const errorTypeAfterEnding = async (error: unknown): Promise<ReadableSpan> => {
  const { tracer, finished } = setup();
  tracer.startAgentSpan(AGENT).end(error);
  return onlySpan(finished);
};

const exceptionEvent = (span: ReadableSpan) => span.events.find((event) => event.name === 'exception');

describe('createTracerPort agent span', () => {
  it('records the agent name, the session as conversation, the run and the attempt', async () => {
    const { tracer, finished } = setup();
    tracer.startAgentSpan(AGENT).end();
    const span = await onlySpan(finished);
    expect(span.name).toBe('invoke_agent momonga');
    expect(span.attributes).toMatchObject({
      'gen_ai.agent.name': 'momonga',
      'gen_ai.conversation.id': 'session-0001',
      'momonga.run_id': 'run-0001',
      'momonga.attempt': 3,
    });
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(span.attributes).not.toHaveProperty('error.type');
  });

  it('exposes the traceparent of its own span', async () => {
    const { tracer, finished } = setup();
    const agent = tracer.startAgentSpan(AGENT);
    agent.end();
    const span = await onlySpan(finished);
    const { traceId, spanId } = span.spanContext();
    expect(agent.traceparent).toBe(`00-${traceId}-${spanId}-01`);
  });
});

describe('createTracerPort tool span', () => {
  it('is a child of the agent span through its traceparent', async () => {
    const { tracer, finished } = setup();
    const agent = tracer.startAgentSpan(AGENT);
    const tool = tracer.startToolSpan(agent, TOOL);
    tool.end();
    agent.end();
    const spans = await finished();
    const agentSpan = spans.find((span) => span.name === 'invoke_agent momonga');
    const toolSpan = spans.find((span) => span.name === 'execute_tool Bash');
    if (agentSpan === undefined || toolSpan === undefined) throw new Error('expected an agent and a tool span');
    expect(toolSpan.spanContext().traceId).toBe(agentSpan.spanContext().traceId);
    expect(toolSpan.parentSpanContext?.spanId).toBe(agentSpan.spanContext().spanId);
    expect(toolSpan.attributes).toMatchObject({
      'gen_ai.tool.name': 'Bash',
      'gen_ai.tool.call.id': 'call_1',
      'gen_ai.tool.type': 'function',
      'momonga.run_id': 'run-0001',
      'momonga.step': 2,
    });
    expect(tool.traceparent).toBe(`00-${toolSpan.spanContext().traceId}-${toolSpan.spanContext().spanId}-01`);
  });

  it('parents on a span known only by its traceparent', async () => {
    const { tracer, finished } = setup();
    const remoteParent = { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01', recordToolContent: () => {}, end: () => {} };
    tracer.startToolSpan(remoteParent, TOOL).end();
    const span = await onlySpan(finished);
    expect(span.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(span.parentSpanContext?.spanId).toBe('b7ad6b7169203331');
  });
});

describe('createTracerPort error.type mapping', () => {
  const rows: Array<[string, () => unknown, string]> = [
    ['a GatewayRequestError maps to its code', gatewayError, 'gateway_closed'],
    ["the string 'cancel' maps to cancelled", () => 'cancel', 'cancelled'],
    ['an AbortError DOMException maps to cancelled', () => new DOMException('aborted', 'AbortError'), 'cancelled'],
    ["the string 'lease_lost' maps to lease_lost", () => 'lease_lost', 'lease_lost'],
    ['a LeaseLostError maps to lease_lost', () => new LeaseLostError(), 'lease_lost'],
    ["the string 'shutdown' maps to shutdown", () => 'shutdown', 'shutdown'],
    ['a ShutdownError maps to shutdown', () => new ShutdownError(), 'shutdown'],
    ['a TimeoutError DOMException maps to timeout', () => new DOMException('timed out', 'TimeoutError'), 'timeout'],
    ['a RangeError maps to its constructor name', () => new RangeError('out of range'), 'RangeError'],
    ['a plain object maps to Object', () => ({ reason: 'x' }), 'Object'],
    ['a number maps to unknown', () => 42, 'unknown'],
    ['an unrecognised string maps to unknown', () => 'boom', 'unknown'],
    ['null maps to unknown', () => null, 'unknown'],
  ];

  for (const [title, make, expected] of rows) {
    it(title, async () => {
      const span = await errorTypeAfterEnding(make());
      expect(span.attributes['error.type']).toBe(expected);
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
    });
  }

  it('maps errors on tool spans the same way', async () => {
    const { tracer, finished } = setup();
    const agent = tracer.startAgentSpan(AGENT);
    tracer.startToolSpan(agent, TOOL).end(new ShutdownError());
    const [span] = await finished();
    expect(span?.attributes['error.type']).toBe('shutdown');
  });
});

describe('createTracerPort error message rule', () => {
  it('records the message of a GatewayRequestError', async () => {
    const span = await errorTypeAfterEnding(gatewayError());
    expect(exceptionEvent(span)?.attributes?.['exception.message']).toBe('the gateway is closing');
  });

  it('never records the message of any other error', async () => {
    const span = await errorTypeAfterEnding(new Error('SENTINEL-user-secret-7f3a'));
    expect(span.attributes['error.type']).toBe('Error');
    const event = exceptionEvent(span);
    expect(event?.attributes).not.toHaveProperty('exception.message');
    expect(JSON.stringify({ attributes: span.attributes, events: span.events, status: span.status })).not.toContain('SENTINEL-user-secret-7f3a');
  });
});

describe('createTracerPort message content', () => {
  const CONTENT = { arguments: { command: 'echo hi' }, result: 'hi' };

  it('records no tool content by default', async () => {
    const { tracer, finished } = setup();
    const agent = tracer.startAgentSpan(AGENT);
    const tool = tracer.startToolSpan(agent, TOOL);
    tool.recordToolContent(CONTENT);
    tool.end();
    agent.end();

    const spans = await finished();

    const keys = spans.flatMap((span) => Object.keys(span.attributes));
    expect(keys).not.toContain('gen_ai.tool.call.arguments');
    expect(keys).not.toContain('gen_ai.tool.call.result');
  });

  it('records the arguments and the result on the tool span as JSON when the user opted in', async () => {
    const { tracer, finished } = setup(true);
    const agent = tracer.startAgentSpan(AGENT);
    const tool = tracer.startToolSpan(agent, TOOL);
    tool.recordToolContent(CONTENT);
    tool.end();
    agent.end();

    const spans = await finished();

    const toolSpan = spans.find((span) => span.attributes['gen_ai.operation.name'] === 'execute_tool');
    expect(toolSpan?.attributes['gen_ai.tool.call.arguments']).toBe(JSON.stringify(CONTENT.arguments));
    expect(toolSpan?.attributes['gen_ai.tool.call.result']).toBe(JSON.stringify(CONTENT.result));
    expect(spans.find((span) => span.attributes['gen_ai.operation.name'] === 'invoke_agent')?.attributes).not.toHaveProperty('gen_ai.tool.call.arguments');
  });
});
