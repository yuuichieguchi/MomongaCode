import { endpointKeyOf } from '@momonga/config';
import type { Capabilities } from '@momonga/protocol';
import type { UpstreamEndpoint } from '../adapters/shared/http-client.ts';
import { PreconditionFailedError, StreamFailure, UpstreamHttpError } from '../adapters/shared/failures.ts';
import type { KeywordSupport } from './envelope.ts';
import { ProbeTimeoutError, createProbeClient } from './client.ts';
import type { ProbeEndpoint } from './client.ts';
import { capabilitiesFromProbe, decideToolCalling, layerOf, mergeCapabilities, withImageDefault } from './decide.ts';
import type { DeclaredCapabilities } from './decide.ts';
import { endpointIdentityOf } from './endpoint-record.ts';
import type { EndpointRecord } from './endpoint-record.ts';
import { parseJson } from './json.ts';
import { needsProbeOf, preconditionOf, remedyOf } from './remedy.ts';

export const IDENTITY_READ_TIMEOUT_MS = 10_000;

export { endpointKeyOf };

export const probeEndpointOf = (upstream: UpstreamEndpoint, apiKey: string | undefined): ProbeEndpoint =>
  upstream.kind === 'unix'
    ? { kind: 'unix', socketPath: upstream.socketPath }
    : { kind: 'tcp', baseUrl: upstream.baseUrl, ...(apiKey === undefined ? {} : { headers: { authorization: `Bearer ${apiKey}` } }) };

export const readModelsListing = async (
  endpoint: ProbeEndpoint,
  signal: AbortSignal,
  timeoutMs: number = IDENTITY_READ_TIMEOUT_MS,
): Promise<unknown> => {
  const client = createProbeClient(endpoint, signal, timeoutMs);
  try {
    const result = await client.get('models');
    if (result.status !== 200) throw new UpstreamHttpError(result.status, null, 'the model listing was refused', undefined, false);
    return parseJson(result.text);
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
  signal: AbortSignal,
  timeoutMs: number = IDENTITY_READ_TIMEOUT_MS,
): Promise<string> => endpointIdentityOf(await readModelsListing(endpoint, signal, timeoutMs), model, fields);

type Verification = { starter: AbortSignal; done: Promise<void> };

const untilAborted = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });

export const memoizedVerification = (verifyOnce: (signal: AbortSignal) => Promise<void>): ((signal: AbortSignal) => Promise<void>) => {
  let verification: Verification | undefined;

  const beginVerification = (signal: AbortSignal): Verification => {
    const started: Verification = {
      starter: signal,
      done: verifyOnce(signal).catch((error: unknown) => {
        if (verification === started) verification = undefined;
        throw error;
      }),
    };
    return started;
  };

  return async (signal) => {
    for (;;) {
      signal.throwIfAborted();
      verification ??= beginVerification(signal);
      const current = verification;
      try {
        return await untilAborted(current.done, signal);
      } catch (error) {
        if (current.starter.aborted && !signal.aborted) continue;
        throw error;
      }
    }
  };
};


export const ollamaServerRefusal = (targetName: string, adapter: string, endpoint: string): PreconditionFailedError =>
  new PreconditionFailedError(
    `the target "${targetName}" points at an Ollama server through the ${adapter} adapter, which loses tool calls there; set adapter: "ollama" for it`,
    `the server at ${endpoint} answered GET /api/version in Ollama's form`,
    'change the adapter of the target to "ollama" and run its probe',
  );

export type ProbedEndpointTargetOptions = {
  targetName: string;
  endpoint: string;
  model: string;
  declared: DeclaredCapabilities;
  record: EndpointRecord | null;
  readIdentity: (fields: readonly string[], signal: AbortSignal) => Promise<string>;
  saveRecord: (record: EndpointRecord) => Promise<void>;
};

export type ProbedEndpointTarget = {
  keywordSupport: () => KeywordSupport;
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
    `the target "${targetName}" sets toolCalling to auto, but no probe record exists`,
    `no record for ${endpoint} and model ${model}`,
  );

  const requireRecord = (): EndpointRecord => {
    if (record === null) throw preconditionOf(needsProbe);
    return record;
  };

  const verifyOnce = async (signal: AbortSignal): Promise<void> => {
    const found = requireRecord();
    const identity = await options.readIdentity(found.identityFields, signal);
    if (identity !== found.identity) {
      throw new PreconditionFailedError(
        `the probe record of the target "${targetName}" is stale`,
        `the server at ${endpoint} now reports a different identity for model ${model} than when it was probed`,
        remedyOf(targetName),
      );
    }
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
    keywordSupport: () => requireRecord().report.keywordSupport,
    verify,
    raiseHeadroom,
    capabilities: async () => {
      if (record === null) return { ...withImageDefault(declared), toolCalling: needsProbe, source: 'unprobed' };
      const decision = decideToolCalling(record.report);
      const { toolCalling, structuredOutput, streaming, stopSequences, outputBoundField, parallelToolCalls, usageReported, reasoning, promptCache } = capabilitiesFromProbe(
        record.report,
        decision,
      );
      return mergeCapabilities({
        defaults: declaredParts.core,
        declared: declaredParts.layer,
        probed: {
          toolCalling,
          structuredOutput,
          streaming,
          stopSequences,
          ...(outputBoundField === undefined ? {} : { outputBoundField }),
          usageReported,
          ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }),
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(promptCache === undefined ? {} : { promptCache }),
        },
        probedAt: record.report.probedAt,
      });
    },
  };
};
