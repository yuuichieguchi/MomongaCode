import { currentSocketResolver } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { ERROR_TYPE_ATTRIBUTE, MOMONGA_ATTRIBUTES, anatomyLayerEntries, describeFallbackCause, isSpanFallbackCauseList } from '@momonga/protocol';
import type { RunTraceCall, SpanFallbackCause, RunTraceEvent, RunTraceSpan, RunTraceView, TokenAnatomy, TraceContentPage } from '@momonga/protocol';
import { createGatewayClient } from '../client/gateway-client.ts';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { escapedLines } from '../terminal-writer.ts';
import { latestRunIdOf } from './targets.ts';

const childrenOf = (spans: readonly RunTraceSpan[], parent: string | null): RunTraceSpan[] =>
  spans.filter((span) => span.parentSpanId === parent).sort((left, right) => left.startMs - right.startMs);

const fallbackCausesOf = (span: RunTraceSpan): SpanFallbackCause[] => {
  const value = span.attributes[MOMONGA_ATTRIBUTES.fallbackCauses];
  if (value === undefined) return [];
  if (typeof value !== 'string') throw new TypeError(`span ${span.spanId} attribute ${MOMONGA_ATTRIBUTES.fallbackCauses} must be a string`);
  const causes: unknown = JSON.parse(value);
  if (!isSpanFallbackCauseList(causes)) throw new TypeError(`span ${span.spanId} attribute ${MOMONGA_ATTRIBUTES.fallbackCauses} must hold a list of fallback causes`);
  return causes;
};

const chatDetail = (span: RunTraceSpan): string => {
  const target = span.attributes[MOMONGA_ATTRIBUTES.target];
  if (typeof target !== 'string') return '';
  const attempt = span.attributes[MOMONGA_ATTRIBUTES.attempt];
  const where = `target ${target}${typeof attempt === 'number' ? `, attempt ${attempt}` : ''}`;
  const failure = span.attributes[MOMONGA_ATTRIBUTES.failureMessage];
  if (typeof failure === 'string') {
    const errorType = span.attributes[ERROR_TYPE_ATTRIBUTE];
    return `  ${where}: ${typeof errorType === 'string' ? `${errorType}: ` : ''}${failure}`;
  }
  const causes = fallbackCausesOf(span);
  return `  ${where}${causes.length === 0 ? '' : `, answered after ${causes.map(describeFallbackCause).join('; ')}`}`;
};

const spanLines = (spans: readonly RunTraceSpan[], parent: string | null, depth: number): string[] =>
  childrenOf(spans, parent).flatMap((span) => [
    `${'  '.repeat(depth)}${span.name}  ${span.endMs - span.startMs} ms  ${span.status}${chatDetail(span)}`,
    ...spanLines(spans, span.spanId, depth + 1),
  ]);

const layerText = (anatomy: TokenAnatomy, name: string, tokens: number): string => {
  if (name !== 'tools') return `${name} ${tokens}`;
  const perTool = Object.entries(anatomy.tools).map(([tool, count]) => `${tool} ${count}`);
  return `tools ${tokens} (${perTool.join(', ')})`;
};

const callLine = (call: RunTraceCall): string => {
  const causes = call.prefix === undefined || call.prefix.causes.length === 0 ? '' : ` [prefix broken by ${call.prefix.causes.join(', ')}]`;
  const prefix = `step ${call.step}, attempt ${call.attempt}:${causes}`;
  const { anatomy } = call;
  if (anatomy === undefined) return `${prefix} layers not recorded`;
  const layers = anatomyLayerEntries(anatomy.layers)
    .filter(([, tokens]) => tokens > 0)
    .map(([name, tokens]) => layerText(anatomy, name, tokens));
  return `${prefix} ${anatomy.total} tokens (estimated) ${layers.join(', ')}`;
};

const eventLine = (event: RunTraceEvent): string =>
  event.type === 'tool.loaded' ? `step ${event.step}: loaded tools: ${event.names.join(', ')}` : `step ${event.step}: loop warned: ${event.signature}`;

export const renderTrace = (trace: RunTraceView): string => {
  const known = new Set(trace.spans.map((span) => span.spanId));
  const roots = trace.spans.filter((span) => span.parentSpanId === null || !known.has(span.parentSpanId));
  const { summary } = trace;
  return escapedLines([
    `run ${trace.runId}: ${summary.steps} steps, ${summary.chatCalls} model calls, ${summary.toolCalls} tool calls, ${summary.errorCount} errors, ${summary.durationMs} ms`,
    `tokens: ${summary.inputTokens} in, ${summary.outputTokens} out`,
    ...(trace.calls ?? []).map(callLine),
    ...(trace.events ?? []).map(eventLine),
    ...roots
      .sort((left, right) => left.startMs - right.startMs)
      .flatMap((root) => [`${root.name}  ${root.endMs - root.startMs} ms  ${root.status}`, ...spanLines(trace.spans, root.spanId, 1)]),
  ]);
};

export type ContentSource = { name: string; page(runId: string, after: number, limit: number): Promise<TraceContentPage> };

export const writeTraceContent = async (sources: readonly ContentSource[], runId: string, { json, pageSize }: { json: boolean; pageSize: number }, write: (text: string) => void): Promise<void> => {
  let shown = 0;
  for (const source of sources) {
    let after: number | null = 0;
    while (after !== null) {
      const page: TraceContentPage = await source.page(runId, after, pageSize);
      for (const body of page.bodies) {
        shown += 1;
        write(
          json
            ? `${JSON.stringify({ store: source.name, ...body })}\n`
            : `${escapedLines([`${source.name} body ${body.id}  span ${body.spanId}  ${body.kind}  expires ${new Date(body.expiresAtMs).toISOString()}`, ...body.content.split('\n')])}\n`,
        );
      }
      after = page.next;
    }
  }
  if (shown === 0 && !json) {
    write(`${escapedLines([`No stored content for run ${runId}: message content is stored only while telemetry.captureMessageContent is on, and each body is removed when it expires.`])}\n`);
  }
};

export type TraceOptions = { json: boolean; content: boolean; pageSize: number };

export const showTrace = async (ports: CliPorts, paths: MomongaPaths, runId: string | undefined, options: TraceOptions): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(ports, paths);
  try {
    const gateway = createGatewayClient({ resolveSocket: currentSocketResolver(paths, 'gateway') });
    try {
      if (options.content) {
        const id = runId ?? (await latestRunIdOf(client, ports.cwd));
        await writeTraceContent(
          [
            { name: 'runtime', page: (run, after, limit) => client.traceContent(run, { after, limit }) },
            { name: 'gateway', page: (run, after, limit) => gateway.contentOf(run, { after, limit }) },
          ],
          id,
          { json: options.json, pageSize: options.pageSize },
          (text) => ports.stdout.write(text),
        );
        return 0;
      }
      const trace = await client.trace(runId ?? (await latestRunIdOf(client, ports.cwd)));
      ports.stdout.write(`${options.json ? JSON.stringify(trace) : renderTrace(trace)}\n`);
    } finally {
      await gateway.close();
    }
    return 0;
  } finally {
    await client.close();
  }
};
