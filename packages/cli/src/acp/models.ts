import { RequestError } from '@agentclientprotocol/sdk';
import { INHERITED_CLASSIFIER } from '@momonga/config';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { displayMapOf, resolveTypedModelRef, typedModelText } from '@momonga/protocol';
import type { ModelViews } from '@momonga/protocol';

export const MODEL_CONFIG_ID = 'model';
export const CLASSIFIER_CONFIG_ID = 'classifier';

const displaysOf = (views: ModelViews): string[] => {
  const displays = displayMapOf(views);
  return views.map((view) => displays.get(view.canon) ?? view.canon);
};

export const modelOptionOf = (views: ModelViews, current: string): SessionConfigOption => ({
  id: MODEL_CONFIG_ID,
  name: 'Model',
  category: 'model',
  type: 'select',
  currentValue: current,
  options: modelChoicesOf(views),
});

const modelChoicesOf = (views: ModelViews): { value: string; name: string }[] => {
  const displays = displaysOf(views);
  return views.map((view, index) => ({ value: view.canon, name: displays[index] ?? view.canon }));
};

export const classifierOptionOf = (views: ModelViews, configured: string | undefined): SessionConfigOption => ({
  id: CLASSIFIER_CONFIG_ID,
  name: 'Auto-mode classifier',
  type: 'select',
  currentValue: configured ?? INHERITED_CLASSIFIER,
  options: [...modelChoicesOf(views), ...unlistedChoiceOf(views, configured), { value: INHERITED_CLASSIFIER, name: "Use the session's model" }],
});

const unlistedChoiceOf = (views: ModelViews, configured: string | undefined): { value: string; name: string }[] =>
  configured === undefined || views.some((view) => view.canon === configured) ? [] : [{ value: configured, name: configured }];

export const selectableClassifierOf = (views: ModelViews, configured: string | undefined, request: { configId: string; value?: unknown }): string => {
  if (request.value === INHERITED_CLASSIFIER) return INHERITED_CLASSIFIER;
  if (configured !== undefined && request.value === configured) return configured;
  const resolution = typeof request.value === 'string' ? resolveTypedModelRef(typedModelText(request.value), views) : undefined;
  if (resolution?.kind !== 'found') {
    throw RequestError.invalidParams(
      { configId: request.configId, value: request.value },
      `The auto-mode classifier "${String(request.value)}" is not ${INHERITED_CLASSIFIER} or one of the configured models: ${displaysOf(views).join(', ')}`,
    );
  }
  return resolution.model.canon;
};

export const selectableModelOf = (views: ModelViews, request: { configId: string; value?: unknown }): string => {
  if (request.configId !== MODEL_CONFIG_ID) {
    throw RequestError.invalidParams(
      { configId: request.configId },
      `the session offers no configuration option ${request.configId}; its options are ${MODEL_CONFIG_ID} and ${CLASSIFIER_CONFIG_ID}`,
    );
  }
  const resolution = typeof request.value === 'string' ? resolveTypedModelRef(typedModelText(request.value), views) : undefined;
  if (resolution?.kind !== 'found') {
    throw RequestError.invalidParams({ configId: request.configId, value: request.value }, `The model "${String(request.value)}" is not one of the configured models: ${displaysOf(views).join(', ')}.`);
  }
  return resolution.model.canon;
};
