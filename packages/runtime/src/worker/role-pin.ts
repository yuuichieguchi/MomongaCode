import type { ModelRoles } from '@momonga/config';
import type { Run, RuntimeStore } from '@momonga/store';
import type { SettingsPort } from '../ports.ts';
import { readRoles } from './pins.ts';

const rolesOfParent = (store: RuntimeStore, parentRunId: string): ModelRoles => {
  const started = store.readRunEventsOfTypes(parentRunId, ['run.started']).find((event) => event.type === 'run.started');
  if (started?.type !== 'run.started') throw new Error(`run ${parentRunId} has no run.started event`);
  return readRoles(started.pins['roles']);
};

export const rolesFor = (input: { store: RuntimeStore; settings: Pick<SettingsPort, 'modelRoles'>; run: Run }): ModelRoles => {
  const { store, settings, run } = input;
  return run.parentRunId === null ? { ...settings.modelRoles() } : rolesOfParent(store, run.parentRunId);
};
