import { GENERATION_RETIRED_CODE, createUdsClient, isRecord } from '@momonga/foundation';
import type { SocketResolver } from '@momonga/foundation';
import { JSON_MODES, agentReadiness, isProbingCapabilities, isToolCallingState } from '@momonga/protocol';
import type { AliasCapabilities, Capabilities, MomongaModelEntry, MomongaModelList, ProbingCapabilities, UsageReport } from '@momonga/protocol';


export type GatewayClient = {
  models(): Promise<readonly MomongaModelEntry[]>;
  modelOf(alias: string): Promise<MomongaModelEntry>;
  capabilitiesOf(alias: string): Promise<AliasCapabilities | ProbingCapabilities>;
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

const isProbingListing = (value: unknown): boolean => isRecord(value) && isToolCallingState(value['toolCalling']) && agentReadiness({ toolCalling: value['toolCalling'] }).state === 'probing';

const isModelList = (value: unknown): value is MomongaModelList =>
  isRecord(value) &&
  Array.isArray(value['data']) &&
  value['data'].every(
    (entry) =>
      isRecord(entry) &&
      typeof entry['id'] === 'string' &&
      Array.isArray(entry['targets']) &&
      entry['targets'].every((target) => typeof target === 'string') &&
      (isCapabilities(entry['capabilities']) || isProbingListing(entry['capabilities'])),
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

const retiredRefusalOf = (text: string): string | undefined => {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const error = isRecord(body) ? body['error'] : undefined;
  return isRecord(error) && error['code'] === GENERATION_RETIRED_CODE && typeof error['message'] === 'string' ? error['message'] : undefined;
};

export const createGatewayClient = (options: { resolveSocket: SocketResolver }): GatewayClient => {
  const http = createUdsClient(options.resolveSocket);

  const send = async (path: string): Promise<{ status: number; text: string }> => {
    const response = await http.request({ method: 'GET', path });
    return { status: response.status, text: await response.text() };
  };

  const getJson = async (path: string): Promise<unknown> => {
    const first = await send(path);
    const answer = retiredRefusalOf(first.text) === undefined ? first : await send(path);
    const refusal = retiredRefusalOf(answer.text);
    if (refusal !== undefined) throw new Error(refusal);
    if (answer.status !== 200) throw new Error(`GET ${path} answered ${answer.status}: ${answer.text}`);
    return JSON.parse(answer.text);
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

  const capabilitiesOf = async (alias: string): Promise<AliasCapabilities | ProbingCapabilities> => (await modelOf(alias)).capabilities;

  const contextWindowOf = async (alias: string): Promise<number> => {
    const capabilities = await capabilitiesOf(alias);
    if (isProbingCapabilities(capabilities)) throw new Error(capabilities.toolCalling.message);
    return capabilities.contextWindow;
  };

  const usageOf = async (runId: string): Promise<UsageReport> => {
    const path = `/v1/momonga/usage?run_id=${encodeURIComponent(runId)}`;
    const body = await getJson(path);
    if (!isUsageReport(body)) throw new Error(`GET ${path} answered a body that is not a usage report: ${JSON.stringify(body)}`);
    return body;
  };

  return { models, modelOf, capabilitiesOf, contextWindowOf, usageOf, close: () => http.close() };
};
