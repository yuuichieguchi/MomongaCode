import { createUdsClient, isRecord } from '@momonga/foundation';
import type { MomongaModelList, UsageReport } from '@momonga/protocol';

export type GatewayClient = {
  contextWindowOf(alias: string): Promise<number>;
  usageOf(runId: string): Promise<UsageReport>;
  close(): Promise<void>;
};

const isModelList = (value: unknown): value is MomongaModelList =>
  isRecord(value) &&
  Array.isArray(value['data']) &&
  value['data'].every((entry) => isRecord(entry) && typeof entry['id'] === 'string' && isRecord(entry['capabilities']) && typeof entry['capabilities']['contextWindow'] === 'number');

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

  const contextWindowOf = async (alias: string): Promise<number> => {
    const body = await getJson('/v1/momonga/models');
    if (!isModelList(body)) throw new Error(`GET /v1/momonga/models answered a body that is not a model list: ${JSON.stringify(body)}`);
    const entry = body.data.find((candidate) => candidate.id === alias);
    if (entry === undefined) throw new Error(`the gateway does not list the model alias ${alias}`);
    return entry.capabilities.contextWindow;
  };

  const usageOf = async (runId: string): Promise<UsageReport> => {
    const path = `/v1/momonga/usage?run_id=${encodeURIComponent(runId)}`;
    const body = await getJson(path);
    if (!isUsageReport(body)) throw new Error(`GET ${path} answered a body that is not a usage report: ${JSON.stringify(body)}`);
    return body;
  };

  return { contextWindowOf, usageOf, close: () => http.close() };
};
