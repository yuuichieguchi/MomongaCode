import { RequestError } from '@agentclientprotocol/sdk';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { displayMapOf, resolveTypedModelRef, typedModelText } from '@momonga/protocol';
import type { ModelViews } from '@momonga/protocol';

export const MODEL_CONFIG_ID = 'model';

const displaysOf = (views: ModelViews): string[] => {
  const displays = displayMapOf(views);
  return views.map((view) => displays.get(view.canon) ?? view.canon);
};

export const modelOptionOf = (views: ModelViews, current: string): SessionConfigOption => {
  const displays = displaysOf(views);
  return {
    id: MODEL_CONFIG_ID,
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: current,
    options: views.map((view, index) => ({ value: view.canon, name: displays[index] ?? view.canon })),
  };
};

export const selectableModelOf = (views: ModelViews, request: { configId: string; value?: unknown }): string => {
  if (request.configId !== MODEL_CONFIG_ID) {
    throw RequestError.invalidParams({ configId: request.configId }, `the session offers no configuration option ${request.configId}; its only option is ${MODEL_CONFIG_ID}`);
  }
  const resolution = typeof request.value === 'string' ? resolveTypedModelRef(typedModelText(request.value), views) : undefined;
  if (resolution?.kind !== 'found') {
    throw RequestError.invalidParams({ configId: request.configId, value: request.value }, `The model "${String(request.value)}" is not one of the configured models: ${displaysOf(views).join(', ')}.`);
  }
  return resolution.model.canon;
};
