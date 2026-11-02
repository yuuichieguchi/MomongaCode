import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import type { SpanExporter } from '@opentelemetry/sdk-trace';
import { RUNTIME_TEARDOWN_BUDGET_MS, transportUrlMessage, transportUrlProblem } from '@momonga/foundation';

export type OtlpExporterSettings = { endpoint: string; headers?: Record<string, string> };

const TRACES_PATH = 'v1/traces';

export const OTLP_TEARDOWN_SHARE = 0.5;
export const OTLP_EXPORTS_PER_TEARDOWN = 2;
export const OTLP_EXPORT_TIMEOUT_MS = (RUNTIME_TEARDOWN_BUDGET_MS * OTLP_TEARDOWN_SHARE) / OTLP_EXPORTS_PER_TEARDOWN;

export type OtlpExporterOptions = { timeoutMs?: number };

export const otlpTracesUrl = (endpoint: string): string => {
  const problem = transportUrlProblem(endpoint);
  if (problem !== undefined) throw new TypeError(transportUrlMessage('OTLP endpoint', endpoint, problem));
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`}${TRACES_PATH}`;
  return url.toString();
};

export const createOtlpTraceExporter = (settings: OtlpExporterSettings, options: OtlpExporterOptions = {}): SpanExporter =>
  new OTLPTraceExporter({
    url: otlpTracesUrl(settings.endpoint),
    timeoutMillis: options.timeoutMs ?? OTLP_EXPORT_TIMEOUT_MS,
    ...(settings.headers === undefined ? {} : { headers: settings.headers }),
  });

export const exportersFor = (settings: { otlp?: OtlpExporterSettings } | undefined): SpanExporter[] =>
  settings?.otlp === undefined ? [] : [createOtlpTraceExporter(settings.otlp)];
