export const MODEL_SETTINGS_ROW = 'Model settings…';

export const MODEL_SETTINGS_ACTIONS = ['Add a model', 'Model for new sessions', 'Fallback models', 'Billing changes', 'Models for other roles', 'Wait limits', 'Programs', 'Check the servers'] as const;

export type ModelSettingsAction = (typeof MODEL_SETTINGS_ACTIONS)[number];

export const modelSettingsPath = (action: ModelSettingsAction): string => `/model, then ${MODEL_SETTINGS_ROW}, then ${action}`;
