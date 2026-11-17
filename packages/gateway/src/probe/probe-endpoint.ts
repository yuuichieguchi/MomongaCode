import type { DialectId, ProbeReport, ToolCallingMode } from '@momonga/protocol';
import { NO_USER_DIALECTS } from '../dialect/choice.ts';
import type { UserDialects } from '../dialect/choice.ts';
import type { UpstreamEndpoint } from '../adapters/shared/http-client.ts';
import { decideToolCalling } from './decide.ts';
import type { DialectCurrency } from '../dialect/candidates.ts';
import { recordProbe } from './auto-probe.ts';
import { measuringAskOf } from './sources.ts';
import type { MeasureProbe, ProbePrecondition, ProbeSubject } from './auto-probe.ts';
import { endpointIdentityOf, endpointKeyOfLock, endpointLockKeyOf, requireListedEntry, saveEndpointRecord, stableIdentityFieldsOf } from './endpoint-record.ts';
import { listedEntryOf } from './reply.ts';
import type { EndpointKey, EndpointLockKey } from './endpoint-record.ts';
import { IDENTITY_READ_TIMEOUT_MS, probeEndpointOf, readModelsListing } from './endpoint-target.ts';
import { DEFAULT_SAMPLES, DEFAULT_STEP_TIMEOUT_MS, PROBE_METHOD_VERSION, runProbe } from './run-probe.ts';
import type { ProbeHostPorts, ProbePorts } from './client.ts';
import { requireMeasurementConsent } from './consent.ts';
import type { MeasurementBound, MeteredMeasurement } from './consent.ts';
import type { KernelLockMechanism } from '@momonga/foundation';

export type ProbeEndpointTargetOptions = {
  ports: ProbePorts;
  metered?: MeteredMeasurement;
  stepTimeoutMs?: number;
  probeRecordDir: string;
  lock: KernelLockMechanism;
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

export type EndpointMeasurement = { report: ProbeReport; identity: string; identityFields: string[] };

export type MeasureEndpointOptions = Omit<ProbeEndpointTargetOptions, 'probeRecordDir' | 'lock' | 'key' | 'signal' | 'metered'> & {
  metered?: { measurement: MeteredMeasurement; consented: () => Promise<MeasurementBound> };
};

export const measureEndpoint =
  (options: MeasureEndpointOptions): MeasureProbe<EndpointLockKey, EndpointMeasurement> =>
  async ({ signal, progress }) => {
    const metered = options.metered === undefined ? undefined : { measurement: options.metered.measurement, bound: await options.metered.consented() };
    const endpoint = probeEndpointOf(options.upstream, options.apiKey);
    const firstListing = await readModelsListing(endpoint, options.ports, signal);
    requireListedEntry(firstListing, options.model);
    const report = await runProbe({
      ...(endpoint.kind === 'unix' ? { socketPath: endpoint.socketPath } : { baseUrl: endpoint.baseUrl, network: endpoint.network, ...(endpoint.headers === undefined ? {} : { headers: endpoint.headers }) }),
      model: options.model,
      ...(options.userDialects === undefined ? {} : { userDialects: options.userDialects }),
      ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
      ports: options.ports,
      progress,
      ...(metered === undefined ? {} : { metered }),
      ...(options.stepTimeoutMs === undefined ? {} : { stepTimeoutMs: options.stepTimeoutMs }),
      signal,
      ...(options.samples === undefined ? {} : { samples: options.samples }),
    });
    const secondListing = await readModelsListing(endpoint, options.ports, signal);
    const identityFields = stableIdentityFieldsOf(firstListing, secondListing, options.model);
    return { report, identity: endpointIdentityOf(firstListing, options.model, identityFields), identityFields };
  };

export const meteredGateOf = (probeRecordDir: string, key: EndpointKey, measurement: MeteredMeasurement, samples: number): NonNullable<MeasureEndpointOptions['metered']> => ({
  measurement,
  consented: () => requireMeasurementConsent(probeRecordDir, key, measurement, samples),
});

export const endpointPrecondition = (displayOf: () => string, upstream: UpstreamEndpoint, ports: ProbeHostPorts, model: string, apiKey: (signal: AbortSignal) => Promise<string | undefined>): ProbePrecondition => ({
  boundMs: IDENTITY_READ_TIMEOUT_MS,
  check: async (signal) => {
    const listing = await readModelsListing(probeEndpointOf(upstream, await apiKey(signal)), ports, signal);
    if (listedEntryOf(listing, model) !== undefined) return { kind: 'met' };
    return {
      kind: 'refused',
      message: `the server does not list the model "${model}"`,
      detail: 'GET /v1/models has no entry whose id is the id of the model',
      remedy: `set the id of the model "${displayOf()}" to one that GET /v1/models lists, or serve the model under that id`,
    };
  },
});

export type EndpointProbeSubjectOptions = {
  target: string;
  key: EndpointKey;
  probeRecordDir: string;
  lock: KernelLockMechanism;
  precondition: ProbePrecondition;
  measure: MeasureProbe<EndpointLockKey, EndpointMeasurement>;
  currency: DialectCurrency;
};

export const endpointProbeSubject = (options: EndpointProbeSubjectOptions): ProbeSubject<EndpointLockKey, EndpointMeasurement> => ({
  target: options.target,
  unknown: measuringAskOf(options.target, ['toolCalling']),
  readKey: async () => endpointLockKeyOf(options.key),
  precondition: options.precondition,
  measure: options.measure,
  save: (key, measured) => saveEndpointRecord(options.probeRecordDir, endpointKeyOfLock(key), measured.identity, measured.identityFields, measured.report, options.currency, options.lock),
});

const measureOptionsOf = ({ metered, probeRecordDir, lock: _lock, key, signal: _signal, ...rest }: ProbeEndpointTargetOptions): MeasureEndpointOptions => ({
  ...rest,
  ...(metered === undefined ? {} : { metered: meteredGateOf(probeRecordDir, key, metered, rest.samples ?? DEFAULT_SAMPLES) }),
});

export const probeEndpointTarget = async (options: ProbeEndpointTargetOptions): Promise<ProbeEndpointTargetResult> => {
  const subject = endpointProbeSubject({
    target: endpointLockKeyOf(options.key).target,
    key: options.key,
    probeRecordDir: options.probeRecordDir,
    lock: options.lock,
    precondition: endpointPrecondition(() => endpointLockKeyOf(options.key).target, options.upstream, options.ports, options.model, async () => options.apiKey),
    measure: measureEndpoint(measureOptionsOf(options)),
    currency: {
      userDialects: options.userDialects ?? NO_USER_DIALECTS,
      probeMethod: PROBE_METHOD_VERSION,
      ...(options.declaredDialect === undefined ? {} : { declaredDialect: options.declaredDialect }),
    },
  });
  const { report: measured } = await recordProbe(subject, options.probeRecordDir, options.lock, options.ports.timers, options.signal ?? new AbortController().signal, options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
  return { report: measured.report, toolCalling: decideToolCalling(measured.report).mode, key: options.key, identity: measured.identity, identityFields: measured.identityFields };
};
