import { endpointKeyOf } from '@momonga/config';
import { startSharedCall } from '@momonga/foundation';
import type { SharedCall } from '@momonga/foundation';
import type { Capabilities, ConstructSupport, DialectId, Probing } from '@momonga/protocol';
import { targetProbingError } from './auto-probe.ts';
import type { UpstreamEndpoint } from '../adapters/shared/http-client.ts';
import { PreconditionFailedError, StreamFailure, UpstreamHttpError } from '../adapters/shared/failures.ts';
import { FULL_KEYWORD_SUPPORT } from '../dialect/keyword-support.ts';
import type { KeywordSupport } from '../dialect/keyword-support.ts';
import { resolveDialectId } from '../dialect/resolve-id.ts';
import { ProbeTimeoutError, createProbeClient } from './client.ts';
import type { ProbePorts } from './client.ts';
import type { ProbeEndpoint } from './client.ts';
import { capabilitiesFromProbe, decideToolCalling, layerOf, mergeCapabilities, withImageDefault } from './decide.ts';
import type { ProbeOutputPolicy } from './decide.ts';
import type { DeclaredCapabilities } from './decide.ts';
import { endpointIdentityOf } from './endpoint-record.ts';
import { recordForIdentity } from './record.ts';
import type { EndpointRecord } from './endpoint-record.ts';
import type { EnvelopeShape } from './envelope.ts';
import { parseExternalJson } from '../adapters/shared/json.ts';
import { declaredDialectRefusal, needsProbeOf, preconditionOf } from './remedy.ts';

export const IDENTITY_READ_TIMEOUT_MS = 10_000;

export { endpointKeyOf };

export const probeEndpointOf = (upstream: UpstreamEndpoint, apiKey: string | undefined): ProbeEndpoint =>
  upstream.kind === 'unix'
    ? { kind: 'unix', socketPath: upstream.socketPath }
    : { kind: 'tcp', baseUrl: upstream.baseUrl, network: upstream.network, ...(apiKey === undefined ? {} : { headers: { authorization: `Bearer ${apiKey}` } }) };

export const readModelsListing = async (
  endpoint: ProbeEndpoint,
  ports: ProbePorts,
  signal: AbortSignal,
  timeoutMs: number = IDENTITY_READ_TIMEOUT_MS,
): Promise<unknown> => {
  const client = createProbeClient(endpoint, signal, timeoutMs, ports.timers);
  try {
    const result = await client.get('models');
    if (result.status !== 200) throw new UpstreamHttpError(result.status, null, 'the model listing was refused', undefined, false);
    return parseExternalJson(result.text);
  } catch (error) {
    if (error instanceof ProbeTimeoutError) {
      throw new StreamFailure('provider_unavailable', 'server_error', `the model listing did not answer within ${error.timeoutMs} ms`);
    }
    throw error;
  } finally {
    await client.close();
  }
};

export const readEndpointIdentity = async (
  endpoint: ProbeEndpoint,
  model: string,
  fields: readonly string[],
  ports: ProbePorts,
  signal: AbortSignal,
  timeoutMs: number = IDENTITY_READ_TIMEOUT_MS,
): Promise<string> => endpointIdentityOf(await readModelsListing(endpoint, ports, signal, timeoutMs), model, fields);

const NEVER_ENDED = new AbortController().signal;

export const memoizedVerification = (verifyOnce: (signal: AbortSignal) => Promise<void>): ((signal: AbortSignal) => Promise<void>) => {
  let verification: SharedCall<void> | undefined;

  return (signal) => {
    if (verification === undefined) {
      const forget = (): void => {
        if (verification === started) verification = undefined;
      };
      const started: SharedCall<void> = startSharedCall(
        NEVER_ENDED,
        async (shared) => {
          try {
            await verifyOnce(shared);
          } catch (error) {
            forget();
            throw error;
          }
        },
        forget,
      );
      verification = started;
    }
    return verification.join(signal);
  };
};

export const ollamaServerRefusal = (targetName: string, adapter: string, endpoint: string): PreconditionFailedError =>
  new PreconditionFailedError(
    `the model "${targetName}" is served by an Ollama server through the ${adapter} adapter, which loses tool calls there; set adapter: "ollama" for its server`,
    `the server at ${endpoint} answered GET /api/version in Ollama's form`,
    'change the adapter of its server to "ollama" and run its probe',
  );

export type ProbedEndpointTargetOptions = {
  targetName: string;
  endpoint: string;
  model: string;
  declared: DeclaredCapabilities;
  record: EndpointRecord | null;
  readRecord: () => Promise<EndpointRecord | null>;
  startProbe: () => Promise<Probing>;
  readIdentity: (fields: readonly string[], signal: AbortSignal) => Promise<string>;
  saveRecord: (record: EndpointRecord) => Promise<void>;
  outputPolicy?: () => ProbeOutputPolicy;
};

export type ProbedEndpointTarget = {
  keywordSupport: () => KeywordSupport;
  schemaDialect: () => DialectId;
  constructSupport: () => ConstructSupport | undefined;
  envelopeShape: () => EnvelopeShape;
  capabilities: () => Promise<Capabilities>;
  verify: (signal: AbortSignal) => Promise<void>;
  raiseHeadroom: (hiddenReasoningTokens: number) => Promise<void>;
};

export const createProbedEndpointTarget = (options: ProbedEndpointTargetOptions): ProbedEndpointTarget => {
  const { targetName, endpoint, model, declared } = options;
  const declaredParts = layerOf(declared);
  let record = options.record;
  let saving: Promise<void> = Promise.resolve();
  const needsProbe = needsProbeOf(
    targetName,
    `the model "${targetName}" sets toolCalling to auto, but no probe record exists`,
    `no record for ${endpoint} and model ${model}`,
  );

  const requireRecord = (): EndpointRecord => {
    if (record === null) throw preconditionOf(needsProbe);
    return record;
  };

  let currentIdentity: string | undefined;

  const usable = (found: EndpointRecord | null): EndpointRecord | null =>
    found === null || currentIdentity === undefined ? found : recordForIdentity(found, { identity: found.identity }, { identity: currentIdentity });

  const verifyOnce = async (signal: AbortSignal): Promise<void> => {
    const found = await options.readRecord();
    currentIdentity = undefined;
    if (found !== null) currentIdentity = await options.readIdentity(found.identityFields, signal);
    record = usable(found);
    if (record === null) throw targetProbingError(await options.startProbe());
  };

  const verify = memoizedVerification(verifyOnce);

  const raiseHeadroom = (hiddenReasoningTokens: number): Promise<void> => {
    const found = requireRecord();
    const { reasoning } = found.report;
    if (reasoning?.control === 'reasoning_effort') return Promise.resolve();
    const recorded = reasoning?.headroomTokens ?? 0;
    if (hiddenReasoningTokens <= recorded) return Promise.resolve();
    const raised: EndpointRecord = {
      ...found,
      report: { ...found.report, reasoning: { control: 'none', headroomTokens: hiddenReasoningTokens } },
    };
    record = raised;
    saving = saving.catch(() => undefined).then(() => options.saveRecord(raised));
    return saving;
  };

  return {
    keywordSupport: () => requireRecord().report.keywordSupport ?? FULL_KEYWORD_SUPPORT,
    schemaDialect: () => resolveDialectId(declared.schemaDialect, record?.report ?? null),
    constructSupport: () => record?.report.constructSupport,
    envelopeShape: () => record?.report.schemaDialect.shape ?? 'union',
    verify,
    raiseHeadroom,
    capabilities: async () => {
      record = usable(await options.readRecord());
      if (record === null) throw targetProbingError(await options.startProbe());
      const refusal = declaredDialectRefusal(targetName, declared.schemaDialect, record.report.schemaDialect, `the server at ${endpoint} for model ${model}`);
      const decision = decideToolCalling(record.report);
      const { toolCalling, structuredOutput, jsonMode, streaming, stopSequences, outputBoundField, parallelToolCalls, usageReported, reasoning, promptCache } = capabilitiesFromProbe(
        record.report,
        decision,
        {},
        options.outputPolicy?.(),
      );
      return mergeCapabilities({
        defaults: { ...declaredParts.core, schemaDialect: resolveDialectId(declared.schemaDialect, record.report) },
        declared: declaredParts.layer,
        probed: {
          toolCalling: refusal ?? toolCalling,
          structuredOutput,
          streaming,
          stopSequences,
          ...(outputBoundField === undefined ? {} : { outputBoundField }),
          usageReported,
          ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(promptCache === undefined ? {} : { promptCache }),
          ...(jsonMode === undefined ? {} : { jsonMode }),
        },
        probedAt: record.report.probedAt,
      });
    },
  };
};
