import { contextOf, recordError, recordToolContent, startAgentSpan, startToolSpan, traceparentOf } from '@momonga/observability';
import type { Telemetry } from '@momonga/observability';
import type { Span } from '@opentelemetry/api';
import { GatewayRequestError } from './gateway-client.ts';
import type { TracerPort, TraceSpan } from './ports.ts';
import { LeaseLostError, ShutdownError } from './worker/errors.ts';

const AGENT_NAME = 'momonga';

const isDomException = (error: unknown, name: string): boolean => error instanceof DOMException && error.name === name;

const errorTypeOf = (error: unknown): string => {
  if (error instanceof GatewayRequestError) return error.code;
  if (error === 'cancel' || isDomException(error, 'AbortError')) return 'cancelled';
  if (error === 'lease_lost' || error instanceof LeaseLostError) return 'lease_lost';
  if (error === 'shutdown' || error instanceof ShutdownError) return 'shutdown';
  if (isDomException(error, 'TimeoutError')) return 'timeout';
  if (typeof error !== 'object' || error === null) return 'unknown';
  const constructor: unknown = Object.getPrototypeOf(error)?.constructor;
  return typeof constructor === 'function' && constructor.name !== '' ? constructor.name : 'unknown';
};

const traceSpanOf = (span: Span, captureMessageContent: boolean): TraceSpan => ({
  traceparent: traceparentOf(span),
  recordToolContent: (content) => {
    if (captureMessageContent) recordToolContent(span, content);
  },
  end: (error) => {
    if (error !== undefined) recordError(span, error, errorTypeOf(error), error instanceof GatewayRequestError ? error.message : undefined);
    span.end();
  },
});

export const createTracerPort = (telemetry: Telemetry): TracerPort => ({
  startAgentSpan: (input) =>
    traceSpanOf(
      startAgentSpan(telemetry.tracer, {
        agentName: AGENT_NAME,
        agentId: AGENT_NAME,
        conversationId: input.sessionId,
        runId: input.runId,
        attempt: input.attempt,
      }),
      telemetry.captureMessageContent,
    ),
  startToolSpan: (parent, input) =>
    traceSpanOf(
      startToolSpan(
        telemetry.tracer,
        { toolName: input.toolName, toolCallId: input.callId, toolType: input.toolType, runId: input.runId, step: input.step },
        contextOf(parent.traceparent),
      ),
      telemetry.captureMessageContent,
    ),
});
