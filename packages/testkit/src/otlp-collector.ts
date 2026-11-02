import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type CollectedOtlpRequest = {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  raw: string;
  body: unknown;
};

export type OtlpCollectorResponse = { status: number; body?: string } | { hang: true };

export type OtlpCollector = {
  endpoint: string;
  requests: readonly CollectedOtlpRequest[];
  respondWith(response: OtlpCollectorResponse): void;
  close(): Promise<void>;
};

const readBody = async (request: http.IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export const startOtlpCollector = async (): Promise<OtlpCollector> => {
  const requests: CollectedOtlpRequest[] = [];
  let response: OtlpCollectorResponse = { status: 200, body: '{}' };
  const server = http.createServer((request, reply) => {
    void readBody(request).then((raw) => {
      requests.push({ method: request.method ?? '', path: request.url ?? '', headers: request.headers, raw, body: raw === '' ? undefined : JSON.parse(raw) });
      if ('hang' in response) return;
      reply.writeHead(response.status, { 'content-type': 'application/json' });
      reply.end(response.body ?? '');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    respondWith: (next) => {
      response = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      }),
  };
};

type OtlpValue = {
  stringValue?: string;
  intValue?: string | number;
  boolValue?: boolean;
  doubleValue?: number;
  arrayValue?: { values: OtlpValue[] };
};
type OtlpAttribute = { key: string; value: OtlpValue };
type OtlpSpanJson = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttribute[];
};
type OtlpTracesJson = {
  resourceSpans: {
    resource: { attributes: OtlpAttribute[] };
    schemaUrl?: string;
    scopeSpans: { scope: { name: string }; schemaUrl?: string; spans: OtlpSpanJson[] }[];
  }[];
};

export const OTLP_SPAN_KIND = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 } as const;

export type DecodedOtlpSpan = {
  service: string;
  scope: string;
  scopeSchemaUrl: string | undefined;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  startNano: bigint;
  endNano: bigint;
  attributes: Record<string, unknown>;
};

const plainValue = (value: OtlpValue): unknown => {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.intValue !== undefined) return Number(value.intValue);
  if (value.boolValue !== undefined) return value.boolValue;
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue !== undefined) return value.arrayValue.values.map(plainValue);
  throw new Error(`unsupported OTLP attribute value ${JSON.stringify(value)}`);
};

export const otlpAttributes = (attributes: readonly OtlpAttribute[] | undefined): Record<string, unknown> =>
  Object.fromEntries((attributes ?? []).map((attribute) => [attribute.key, plainValue(attribute.value)]));

export const decodeOtlpSpans = (requests: readonly CollectedOtlpRequest[]): DecodedOtlpSpan[] =>
  requests.flatMap((request) => {
    if (request.method !== 'POST' || request.path !== '/v1/traces') throw new Error(`unexpected OTLP request ${request.method} ${request.path}`);
    return (request.body as OtlpTracesJson).resourceSpans.flatMap((resource) => {
      const service = otlpAttributes(resource.resource.attributes)['service.name'];
      if (typeof service !== 'string') throw new Error('OTLP resource without a service.name');
      return resource.scopeSpans.flatMap((scope) =>
        scope.spans.map((span) => ({
          service,
          scope: scope.scope.name,
          scopeSchemaUrl: scope.schemaUrl,
          traceId: span.traceId,
          spanId: span.spanId,
          parentSpanId: span.parentSpanId ?? '',
          name: span.name,
          kind: span.kind,
          startNano: BigInt(span.startTimeUnixNano),
          endNano: BigInt(span.endTimeUnixNano),
          attributes: otlpAttributes(span.attributes),
        })),
      );
    });
  });
