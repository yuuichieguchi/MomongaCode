import { RequestError } from '@agentclientprotocol/sdk';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';

export const MODEL_CONFIG_ID = 'model';

export const modelOptionOf = (aliases: readonly string[], current: string): SessionConfigOption => ({
  id: MODEL_CONFIG_ID,
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: current,
  options: aliases.map((alias) => ({ value: alias, name: alias })),
});

export const selectableAliasOf = (aliases: readonly string[], request: { configId: string; value?: unknown }): string => {
  if (request.configId !== MODEL_CONFIG_ID) {
    throw RequestError.invalidParams({ configId: request.configId }, `the session offers no configuration option ${request.configId}; its only option is ${MODEL_CONFIG_ID}`);
  }
  const alias = aliases.find((candidate) => candidate === request.value);
  if (alias === undefined) {
    throw RequestError.invalidParams({ configId: request.configId, value: request.value }, `the model ${String(request.value)} is not one of the configured aliases: ${aliases.join(', ')}`);
  }
  return alias;
};
