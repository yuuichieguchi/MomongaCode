import type { TracerPort, TraceSpan } from '@momonga/runtime';

export type RecordedSpan = {
  kind: 'agent' | 'tool';
  traceparent: string;
  parent?: string;
  input: Record<string, unknown>;
  ended: number;
  content: Array<{ arguments: unknown; result?: unknown }>;
  backends: Array<{ source: string; version: string }>;
};

export type FakeTracer = TracerPort & { spans: RecordedSpan[] };

const hex = (value: number, width: number): string => value.toString(16).padStart(width, '0');

export const createFakeTracer = (): FakeTracer => {
  let counter = 0;
  const open = (kind: RecordedSpan['kind'], input: Record<string, unknown>, parent?: TraceSpan): TraceSpan => {
    counter += 1;
    const traceId = parent === undefined ? hex(counter, 32) : (parent.traceparent.split('-')[1] as string);
    const span: RecordedSpan = {
      kind,
      traceparent: `00-${traceId}-${hex(counter, 16)}-01`,
      ...(parent === undefined ? {} : { parent: parent.traceparent }),
      input,
      ended: 0,
      content: [],
      backends: [],
    };
    tracer.spans.push(span);
    return {
      traceparent: span.traceparent,
      recordToolContent: (content) => {
        span.content.push(content);
      },
      recordToolBackend: (backend) => {
        span.backends.push(backend);
      },
      end: () => {
        span.ended += 1;
      },
    };
  };
  const tracer: FakeTracer = {
    spans: [],
    startAgentSpan: (input) => open('agent', { ...input }),
    startToolSpan: (parent, input) => open('tool', { ...input }, parent),
  };
  return tracer;
};
