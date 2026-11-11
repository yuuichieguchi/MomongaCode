import { lookup as systemLookup } from 'node:dns';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { RUNTIME_TEARDOWN_BUDGET_MS, transportUrlMessage, transportUrlProblem } from '@momonga/foundation';
import type { OutboundNetwork } from '@momonga/foundation';
import { createOtlpAgent } from './otlp-agent.ts';

export type OtlpExporterSettings = { endpoint: string; headers?: Record<string, string> };

const TRACES_PATH = 'v1/traces';

export const OTLP_TEARDOWN_SHARE = 0.5;
export const OTLP_EXPORTS_PER_TEARDOWN = 2;
export const OTLP_EXPORT_TIMEOUT_MS = (RUNTIME_TEARDOWN_BUDGET_MS * OTLP_TEARDOWN_SHARE) / OTLP_EXPORTS_PER_TEARDOWN;

export type OtlpExporterOptions = { network: OutboundNetwork; timeoutMs: number };

export const otlpTracesUrl = (endpoint: string): string => {
  const problem = transportUrlProblem(endpoint);
  if (problem !== undefined) throw new TypeError(transportUrlMessage('OTLP endpoint', endpoint, problem));
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}${TRACES_PATH}`;
  return url.toString();
};

export const createOtlpTraceExporter = (settings: OtlpExporterSettings, options: OtlpExporterOptions): SpanExporter => {
  const url = otlpTracesUrl(settings.endpoint);
  const { agent, labelled } = createOtlpAgent(new URL(url), options.network, options.timeoutMs, systemLookup);
  const exporter = new OTLPTraceExporter({
    url,
    timeoutMillis: options.timeoutMs,
    httpAgentOptions: () => agent,
    ...(settings.headers === undefined ? {} : { headers: settings.headers }),
  });
  return {
    export: (spans, resultCallback) => {
      exporter.export(spans, (result) => resultCallback(result.error === undefined ? result : { ...result, error: labelled(result.error) }));
    },
    forceFlush: () => exporter.forceFlush(),
    shutdown: async () => {
      await exporter.shutdown();
      agent.destroy();
    },
  };
};

export const exportersFor = (settings: { otlp?: OtlpExporterSettings } | undefined, network: OutboundNetwork): SpanExporter[] =>
  settings?.otlp === undefined ? [] : [createOtlpTraceExporter(settings.otlp, { network, timeoutMs: OTLP_EXPORT_TIMEOUT_MS })];
