import type { ProbeReport, ToolCallingMode } from '@momonga/protocol';
import type { UpstreamEndpoint } from '../adapters/shared/http-client.ts';
import { decideToolCalling } from './decide.ts';
import { endpointIdentityOf, saveEndpointRecord, stableIdentityFieldsOf } from './endpoint-record.ts';
import type { EndpointKey } from './endpoint-record.ts';
import { endpointKeyOf, probeEndpointOf, readModelsListing } from './endpoint-target.ts';
import { runProbe } from './run-probe.ts';

export type ProbeEndpointTargetOptions = {
  probeRecordDir: string;
  upstream: UpstreamEndpoint;
  model: string;
  apiKey: string | undefined;
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
    signal,
    ...(options.samples === undefined ? {} : { samples: options.samples }),
  });
  const secondListing = await readModelsListing(endpoint, signal);
  const identityFields = stableIdentityFieldsOf(firstListing, secondListing, options.model);
  const identity = endpointIdentityOf(firstListing, options.model, identityFields);
  const key: EndpointKey = { endpoint: endpointKeyOf(options.upstream), model: options.model };
  await saveEndpointRecord(options.probeRecordDir, key, identity, identityFields, report);
  return { report, toolCalling: decideToolCalling(report).mode, key, identity, identityFields };
};
