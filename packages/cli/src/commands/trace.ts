import { currentSocketResolver } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { ERROR_TYPE_ATTRIBUTE, MOMONGA_ATTRIBUTES, anatomyLayerEntries, describeFallbackCause, isFallbackCauseList } from '@momonga/protocol';
import type { FallbackCause, RunTraceCall, RunTraceEvent, RunTraceSpan, RunTraceView, TokenAnatomy, UsageReport } from '@momonga/protocol';
import { createGatewayClient } from '../client/gateway-client.ts';
import { ensureCurrentDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { escapedLines } from '../terminal-writer.ts';
import { latestRunIdOf } from './targets.ts';

const childrenOf = (spans: readonly RunTraceSpan[], parent: string | null): RunTraceSpan[] =>
  spans.filter((span) => span.parentSpanId === parent).sort((left, right) => left.startMs - right.startMs);

const fallbackCausesOf = (span: RunTraceSpan): FallbackCause[] => {
  const value = span.attributes[MOMONGA_ATTRIBUTES.fallbackCauses];
  if (value === undefined) return [];
  if (typeof value !== 'string') throw new TypeError(`span ${span.spanId} attribute ${MOMONGA_ATTRIBUTES.fallbackCauses} must be a string`);
  const causes: unknown = JSON.parse(value);
  if (!isFallbackCauseList(causes)) throw new TypeError(`span ${span.spanId} attribute ${MOMONGA_ATTRIBUTES.fallbackCauses} must hold a list of fallback causes`);
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

export const renderTrace = (trace: RunTraceView, usage: UsageReport): string => {
  const known = new Set(trace.spans.map((span) => span.spanId));
  const roots = trace.spans.filter((span) => span.parentSpanId === null || !known.has(span.parentSpanId));
  const { summary } = trace;
  return escapedLines([
    `run ${trace.runId}: ${summary.steps} steps, ${usage.responses.length} model calls, ${summary.toolCalls} tool calls, ${summary.errorCount} errors, ${summary.durationMs} ms`,
    `tokens: ${usage.total.input_tokens} in, ${usage.total.output_tokens} out`,
    ...(trace.calls ?? []).map(callLine),
    ...(trace.events ?? []).map(eventLine),
    ...roots
      .sort((left, right) => left.startMs - right.startMs)
      .flatMap((root) => [`${root.name}  ${root.endMs - root.startMs} ms  ${root.status}`, ...spanLines(trace.spans, root.spanId, 1)]),
  ]);
};

export const showTrace = async (ports: CliPorts, paths: MomongaPaths, runId: string | undefined, json: boolean): Promise<number> => {
  await ensureCurrentDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const trace = await client.trace(runId ?? (await latestRunIdOf(client, ports.cwd)));
    const gateway = createGatewayClient({ resolveSocket: currentSocketResolver(paths, 'gateway') });
    try {
      const usage = await gateway.usageOf(trace.runId);
      ports.stdout.write(`${json ? JSON.stringify({ ...trace, usage }) : renderTrace(trace, usage)}\n`);
    } finally {
      await gateway.close();
    }
    return 0;
  } finally {
    await client.close();
  }
};
