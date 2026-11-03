import type { ModelRoles } from '@momonga/config';
import type { Run, RuntimeStore } from '@momonga/store';
import type { SettingsPort } from '../ports.ts';
import { parentPinsOf } from './pins.ts';

export const rolesFor = (input: { store: RuntimeStore; settings: Pick<SettingsPort, 'modelRoles'>; run: Run }): ModelRoles => {
  const { store, settings, run } = input;
  return run.parentRunId === null ? { ...settings.modelRoles() } : parentPinsOf(store, run.parentRunId).roles;
};
