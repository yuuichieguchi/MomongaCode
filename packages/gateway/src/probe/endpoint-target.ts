import type { Capabilities, ToolCallingMode } from '@momonga/protocol';
import type { UpstreamEndpoint } from '../adapters/shared/http-client.ts';
import { PreconditionFailedError } from '../adapters/shared/failures.ts';
import type { KeywordSupport } from './envelope.ts';
import { createProbeClient } from './client.ts';
import type { ProbeEndpoint } from './client.ts';
import { capabilitiesFromProbe, decideToolCalling } from './decide.ts';
import { endpointIdentityOf } from './endpoint-record.ts';
import type { EndpointRecord } from './endpoint-record.ts';
import { parseJson } from './json.ts';

export const IDENTITY_READ_TIMEOUT_MS = 10_000;

export const endpointKeyOf = (upstream: UpstreamEndpoint): string =>
  upstream.kind === 'unix' ? `unix:${upstream.socketPath}` : upstream.baseUrl.replace(/\/+$/, '');

export const probeEndpointOf = (upstream: UpstreamEndpoint, apiKey: string | undefined): ProbeEndpoint =>
  upstream.kind === 'unix'
    ? { kind: 'unix', socketPath: upstream.socketPath }
    : { kind: 'tcp', baseUrl: upstream.baseUrl, ...(apiKey === undefined ? {} : { headers: { authorization: `Bearer ${apiKey}` } }) };

export const readEndpointIdentity = async (endpoint: ProbeEndpoint, model: string, signal: AbortSignal): Promise<string> => {
  const client = createProbeClient(endpoint, signal, IDENTITY_READ_TIMEOUT_MS);
  try {
    const result = await client.get('models');
    if (result.status !== 200) throw new Error(`GET models answered HTTP ${result.status}: ${result.text.slice(0, 200)}`);
    return endpointIdentityOf(parseJson(result.text), model);
  } finally {
    await client.close();
  }
};

export type ProbedEndpointTargetOptions = {
  targetName: string;
  endpoint: string;
  model: string;
  declared: Capabilities;
  record: EndpointRecord | null;
  readIdentity: () => Promise<string>;
};

export type ProbedEndpointTarget = {
  toolCalling: () => ToolCallingMode;
  keywordSupport: () => KeywordSupport;
  capabilities: () => Promise<Capabilities>;
  verify: () => Promise<void>;
};

const remedyOf = (targetName: string): string => `run \`momonga gateway probe ${targetName}\``;

export const createProbedEndpointTarget = (options: ProbedEndpointTargetOptions): ProbedEndpointTarget => {
  const { targetName, endpoint, model, declared, record } = options;
  let verified: Promise<void> | undefined;

  const requireRecord = (): EndpointRecord => {
    if (record === null) {
      throw new PreconditionFailedError(
        `the target "${targetName}" sets toolCalling to auto, but no probe record exists`,
        `no record for ${endpoint} and model ${model}`,
        remedyOf(targetName),
      );
    }
    return record;
  };

  const verifyOnce = async (): Promise<void> => {
    const found = requireRecord();
    const identity = await options.readIdentity();
    if (identity !== found.identity) {
      throw new PreconditionFailedError(
        `the probe record of the target "${targetName}" is stale`,
        `the server at ${endpoint} now reports a different identity for model ${model} than when it was probed`,
        remedyOf(targetName),
      );
    }
  };

  return {
    toolCalling: () => decideToolCalling(requireRecord().report).mode,
    keywordSupport: () => requireRecord().report.keywordSupport,
    capabilities: async () => {
      if (record === null) return { ...declared, source: 'unprobed' };
      const decision = decideToolCalling(record.report);
      const probed = capabilitiesFromProbe(record.report, decision);
      return {
        ...declared,
        toolCalling: decision.mode,
        structuredOutput: probed.structuredOutput,
        streaming: probed.streaming,
        stopSequences: probed.stopSequences,
        parallelToolCalls: probed.parallelToolCalls,
        usageReported: probed.usageReported,
        ...(probed.reasoning === undefined ? {} : { reasoning: probed.reasoning }),
        source: 'probed',
        probedAt: record.report.probedAt,
      };
    },
    verify: () => {
      verified ??= verifyOnce().catch((error: unknown) => {
        verified = undefined;
        throw error;
      });
      return verified;
    },
  };
};
