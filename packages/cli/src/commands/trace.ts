import type { MomongaPaths } from '@momonga/foundation';
import type { RunTraceSpan, RunTraceView, UsageReport } from '@momonga/protocol';
import { createGatewayClient } from '../client/gateway-client.ts';
import { ensureDaemon } from '../daemon/ensure-daemon.ts';
import type { CliPorts } from '../ports.ts';
import { connectRuntime } from '../run/open-session.ts';
import { latestRunIdOf } from './targets.ts';

const childrenOf = (spans: readonly RunTraceSpan[], parent: string | null): RunTraceSpan[] =>
  spans.filter((span) => span.parentSpanId === parent).sort((left, right) => left.startMs - right.startMs);

const spanLines = (spans: readonly RunTraceSpan[], parent: string | null, depth: number): string[] =>
  childrenOf(spans, parent).flatMap((span) => [
    `${'  '.repeat(depth)}${span.name}  ${span.endMs - span.startMs} ms  ${span.status}`,
    ...spanLines(spans, span.spanId, depth + 1),
  ]);

export const renderTrace = (trace: RunTraceView, usage: UsageReport): string => {
  const known = new Set(trace.spans.map((span) => span.spanId));
  const roots = trace.spans.filter((span) => span.parentSpanId === null || !known.has(span.parentSpanId));
  const { summary } = trace;
  return [
    `run ${trace.runId}: ${summary.steps} steps, ${usage.responses.length} model calls, ${summary.toolCalls} tool calls, ${summary.errorCount} errors, ${summary.durationMs} ms`,
    `tokens: ${usage.total.input_tokens} in, ${usage.total.output_tokens} out`,
    ...roots
      .sort((left, right) => left.startMs - right.startMs)
      .flatMap((root) => [`${root.name}  ${root.endMs - root.startMs} ms  ${root.status}`, ...spanLines(trace.spans, root.spanId, 1)]),
  ].join('\n');
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
