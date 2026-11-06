import { createUdsClient, isRecord } from '@momonga/foundation';
import { JSON_MODES, isProbingEntry, isToolCallingState } from '@momonga/protocol';
import type { AliasCapabilities, Capabilities, ModelProbing, MomongaModelEntry, MomongaModelList, UsageReport } from '@momonga/protocol';

export class ModelProbingError extends Error {
  readonly retryAfterSeconds: number;

  constructor(probing: ModelProbing['probing']) {
    super(probing.message);
    this.name = 'ModelProbingError';
    this.retryAfterSeconds = probing.retryAfterSeconds;
  }
}

export type GatewayClient = {
  models(): Promise<readonly MomongaModelEntry[]>;
  modelOf(alias: string): Promise<MomongaModelEntry>;
  stateOf(alias: string): Promise<AliasCapabilities | ModelProbing>;
  capabilitiesOf(alias: string): Promise<AliasCapabilities>;
  contextWindowOf(alias: string): Promise<number>;
  usageOf(runId: string): Promise<UsageReport>;
  close(): Promise<void>;
};

const oneOf = (value: unknown, allowed: readonly string[]): boolean => typeof value === 'string' && allowed.includes(value);

const isCapabilities = (value: unknown): value is Capabilities =>
  isRecord(value) &&
  typeof value['contextWindow'] === 'number' &&
  typeof value['maxOutputTokens'] === 'number' &&
  isToolCallingState(value['toolCalling']) &&
  oneOf(value['structuredOutput'], ['json_schema', 'none']) &&
  (value['jsonMode'] === undefined || oneOf(value['jsonMode'], JSON_MODES)) &&
  typeof value['streaming'] === 'boolean' &&
  typeof value['stopSequences'] === 'boolean' &&
  typeof value['imageInput'] === 'boolean' &&
  (value['parallelToolCalls'] === undefined || typeof value['parallelToolCalls'] === 'boolean') &&
  typeof value['schemaDialect'] === 'string' &&
  value['schemaDialect'] !== '' &&
  oneOf(value['tokenCounting'], ['exact', 'calibrated', 'estimated']) &&
  typeof value['usageReported'] === 'boolean' &&
  typeof value['maxConcurrency'] === 'number' &&
  oneOf(value['source'], ['declared', 'probed', 'config', 'unprobed']) &&
  (value['tokenErrorRatio'] === undefined || typeof value['tokenErrorRatio'] === 'number') &&
  (value['probedAt'] === undefined || typeof value['probedAt'] === 'string');

const isProbing = (value: unknown): value is ModelProbing['probing'] =>
  isRecord(value) && typeof value['message'] === 'string' && typeof value['retryAfterSeconds'] === 'number';

const isModelList = (value: unknown): value is MomongaModelList =>
  isRecord(value) &&
  Array.isArray(value['data']) &&
  value['data'].every(
    (entry) =>
      isRecord(entry) &&
      typeof entry['id'] === 'string' &&
      Array.isArray(entry['targets']) &&
      entry['targets'].every((target) => typeof target === 'string') &&
      (isCapabilities(entry['capabilities']) || isProbing(entry['probing'])),
  );

const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isUsageReport = (value: unknown): value is UsageReport =>
  isRecord(value) &&
  typeof value['run_id'] === 'string' &&
  Array.isArray(value['responses']) &&
  Array.isArray(value['steps']) &&
  isRecord(value['total']) &&
  isCount(value['total']['input_tokens']) &&
  isCount(value['total']['output_tokens']) &&
  isCount(value['total']['total_tokens']);

export const createGatewayClient = (options: { socketPath: string }): GatewayClient => {
  const http = createUdsClient(options.socketPath);

  const getJson = async (path: string): Promise<unknown> => {
    const response = await http.request({ method: 'GET', path });
    const text = await response.text();
    if (response.status !== 200) throw new Error(`GET ${path} answered ${response.status}: ${text}`);
    return JSON.parse(text);
  };

  const models = async (): Promise<readonly MomongaModelEntry[]> => {
    const body = await getJson('/v1/momonga/models');
    if (!isModelList(body)) throw new Error(`GET /v1/momonga/models answered a body that is not a model list: ${JSON.stringify(body)}`);
    return body.data;
  };

  const modelOf = async (alias: string): Promise<MomongaModelEntry> => {
    const entry = (await models()).find((candidate) => candidate.id === alias);
    if (entry === undefined) throw new Error(`the gateway does not list the model alias ${alias}`);
    return entry;
  };

  const stateOf = async (alias: string): Promise<AliasCapabilities | ModelProbing> => {
    const entry = await modelOf(alias);
    return isProbingEntry(entry) ? { probing: entry.probing } : entry.capabilities;
  };

  const capabilitiesOf = async (alias: string): Promise<AliasCapabilities> => {
    const entry = await modelOf(alias);
    if (isProbingEntry(entry)) throw new ModelProbingError(entry.probing);
    return entry.capabilities;
  };

  const contextWindowOf = async (alias: string): Promise<number> => (await capabilitiesOf(alias)).contextWindow;

  const usageOf = async (runId: string): Promise<UsageReport> => {
    const path = `/v1/momonga/usage?run_id=${encodeURIComponent(runId)}`;
    const body = await getJson(path);
    if (!isUsageReport(body)) throw new Error(`GET ${path} answered a body that is not a usage report: ${JSON.stringify(body)}`);
    return body;
  };

  return { models, modelOf, stateOf, capabilitiesOf, contextWindowOf, usageOf, close: () => http.close() };
};
