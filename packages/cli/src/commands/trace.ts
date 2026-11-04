import { describeFallbackCause } from '@momonga/foundation';
import type { MomongaPaths } from '@momonga/foundation';
import { anatomyLayerEntries } from '@momonga/protocol';
import type { FallbackCauseView, RunTraceCall, RunTraceSpan, RunTraceView, TokenAnatomy, UsageReport } from '@momonga/protocol';
import { createGatewayClient } from '../client/gateway-client.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { escapedLines } from '../terminal-writer.ts';
import { latestRunIdOf } from './targets.ts';

const childrenOf = (spans: readonly RunTraceSpan[], parent: string | null): RunTraceSpan[] =>
  spans.filter((span) => span.parentSpanId === parent).sort((left, right) => left.startMs - right.startMs);

const TARGET_ATTRIBUTE = 'momonga.target';
const ATTEMPT_ATTRIBUTE = 'momonga.attempt';
const FAILURE_MESSAGE_ATTRIBUTE = 'momonga.failure_message';
const FALLBACK_CAUSES_ATTRIBUTE = 'momonga.fallback_causes';
const ERROR_TYPE_ATTRIBUTE = 'error.type';

const fallbackCausesOf = (span: RunTraceSpan): FallbackCauseView[] => {
  const value = span.attributes[FALLBACK_CAUSES_ATTRIBUTE];
  if (value === undefined) return [];
  if (typeof value !== 'string') throw new TypeError(`span ${span.spanId} attribute ${FALLBACK_CAUSES_ATTRIBUTE} must be a string`);
  return JSON.parse(value) as FallbackCauseView[];
};

const chatDetail = (span: RunTraceSpan): string => {
  const target = span.attributes[TARGET_ATTRIBUTE];
  if (typeof target !== 'string') return '';
  const attempt = span.attributes[ATTEMPT_ATTRIBUTE];
  const where = `target ${target}${typeof attempt === 'number' ? `, attempt ${attempt}` : ''}`;
  const failure = span.attributes[FAILURE_MESSAGE_ATTRIBUTE];
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
  const prefix = `step ${call.step}, attempt ${call.attempt}:`;
  const { anatomy } = call;
  if (anatomy === undefined) return `${prefix} layers not recorded`;
  const layers = anatomyLayerEntries(anatomy.layers)
    .filter(([, tokens]) => tokens > 0)
    .map(([name, tokens]) => layerText(anatomy, name, tokens));
  return `${prefix} ${anatomy.total} tokens (estimated) ${layers.join(', ')}`;
};

export const renderTrace = (trace: RunTraceView, usage: UsageReport): string => {
  const known = new Set(trace.spans.map((span) => span.spanId));
  const roots = trace.spans.filter((span) => span.parentSpanId === null || !known.has(span.parentSpanId));
  const { summary } = trace;
  return escapedLines([
    `run ${trace.runId}: ${summary.steps} steps, ${usage.responses.length} model calls, ${summary.toolCalls} tool calls, ${summary.errorCount} errors, ${summary.durationMs} ms`,
    `tokens: ${usage.total.input_tokens} in, ${usage.total.output_tokens} out`,
    ...(trace.calls ?? []).map(callLine),
    ...roots
      .sort((left, right) => left.startMs - right.startMs)
      .flatMap((root) => [`${root.name}  ${root.endMs - root.startMs} ms  ${root.status}`, ...spanLines(trace.spans, root.spanId, 1)]),
  ]);
};

export const showTrace = async (ports: CliPorts, paths: MomongaPaths, runId: string | undefined, json: boolean): Promise<number> => {
  await ensureDaemon(ports, paths);
  const client = connectRuntime(paths);
  try {
    const trace = await client.trace(runId ?? (await latestRunIdOf(client, ports.cwd)));
    const gateway = createGatewayClient({ socketPath: paths.sockets.gateway });
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
