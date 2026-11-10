import type { ModelRoles } from '@momonga/config';
import type { Run, RuntimeStore } from '@momonga/store';
import { parentPinsOf } from './pins.ts';

export const rolesFor = (input: { store: RuntimeStore; listed: ModelRoles; run: Run }): ModelRoles => {
  const { store, listed, run } = input;
  return run.parentRunId === null ? { ...listed } : parentPinsOf(store, run.parentRunId).roles;
};
