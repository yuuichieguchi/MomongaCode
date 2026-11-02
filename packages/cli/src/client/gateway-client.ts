import { createUdsClient, isRecord } from '@momonga/foundation';
import type { MomongaModelList } from '@momonga/protocol';

export type GatewayModels = { contextWindowOf(alias: string): Promise<number> };

export const createGatewayModels = (options: { socketPath: string }): GatewayModels => {
  const http = createUdsClient(options.socketPath);

  const isModelList = (value: unknown): value is MomongaModelList =>
    isRecord(value) &&
    Array.isArray(value['data']) &&
    value['data'].every((entry) => isRecord(entry) && typeof entry['id'] === 'string' && isRecord(entry['capabilities']) && typeof entry['capabilities']['contextWindow'] === 'number');

  const contextWindowOf = async (alias: string): Promise<number> => {
    try {
      const response = await http.request({ method: 'GET', path: '/v1/momonga/models' });
      const text = await response.text();
      if (response.status !== 200) throw new Error(`GET /v1/momonga/models answered ${response.status}: ${text}`);
      const body: unknown = JSON.parse(text);
      if (!isModelList(body)) throw new Error(`GET /v1/momonga/models answered a body that is not a model list: ${text}`);
      const entry = body.data.find((candidate) => candidate.id === alias);
      if (entry === undefined) throw new Error(`the gateway does not list the model alias ${alias}`);
      return entry.capabilities.contextWindow;
    } finally {
      await http.close();
    }
  };

  return { contextWindowOf };
};
