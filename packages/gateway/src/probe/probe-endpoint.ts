import type { DialectId, ProbeReport, ToolCallingMode } from '@momonga/protocol';
import { NO_USER_DIALECTS } from '../dialect/choice.ts';
import type { UserDialects } from '../dialect/choice.ts';
import type { UpstreamEndpoint } from '../adapters/shared/http-client.ts';
import { decideToolCalling } from './decide.ts';
import { endpointIdentityOf, saveEndpointRecord, stableIdentityFieldsOf } from './endpoint-record.ts';
import type { EndpointKey } from './endpoint-record.ts';
import { probeEndpointOf, readModelsListing } from './endpoint-target.ts';
import { PROBE_METHOD_VERSION, runProbe } from './run-probe.ts';

export type ProbeEndpointTargetOptions = {
  probeRecordDir: string;
  upstream: UpstreamEndpoint;
  key: EndpointKey;
  model: string;
  apiKey: string | undefined;
  userDialects?: UserDialects;
  declaredDialect?: DialectId;
  samples?: number;
  signal?: AbortSignal;
};

export type ProbeEndpointTargetResult = {
  report: ProbeReport;
  toolCalling: ToolCallingMode;
  key: EndpointKey;
  identity: string;
  identityFields: string[];
};

export const probeEndpointTarget = async (options: ProbeEndpointTargetOptions): Promise<ProbeEndpointTargetResult> => {
  const signal = options.signal ?? new AbortController().signal;
  const endpoint = probeEndpointOf(options.upstream, options.apiKey);
  const firstListing = await readModelsListing(endpoint, signal);
  const report = await runProbe({
    ...(endpoint.kind === 'unix' ? { socketPath: endpoint.socketPath } : { baseUrl: endpoint.baseUrl, ...(endpoint.headers === undefined ? {} : { headers: endpoint.headers }) }),
    model: options.model,
    ...(options.userDialects === undefined ? {} : { userDialects: options.userDialects }),
    ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
    signal,
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
  const secondListing = await readModelsListing(endpoint, signal);
  const identityFields = stableIdentityFieldsOf(firstListing, secondListing, options.model);
  const identity = endpointIdentityOf(firstListing, options.model, identityFields);
  const { key } = options;
  await saveEndpointRecord(options.probeRecordDir, key, identity, identityFields, report, {
    userDialects: options.userDialects ?? NO_USER_DIALECTS,
    probeMethod: PROBE_METHOD_VERSION,
    ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
  });
  return { report, toolCalling: decideToolCalling(report).mode, key, identity, identityFields };
};
