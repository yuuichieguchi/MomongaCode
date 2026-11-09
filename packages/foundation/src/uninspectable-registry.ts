import { createLiveIdentities } from './platform/live-identities.ts';
import type { LiveIdentitiesPorts } from './platform/live-identities.ts';
import type { UninspectableProcess } from './platform/inspector-types.ts';

export type UninspectableRegistry = {
  firstNaming(context: string, process: UninspectableProcess): boolean;
  size(): number;
};

export type UninspectableRegistryPorts = LiveIdentitiesPorts;

export const createUninspectableRegistry = (ports: UninspectableRegistryPorts = {}): UninspectableRegistry => {
  const identities = createLiveIdentities(ports);
  return {
    firstNaming: (context, process) => identities.add(context, process.pid, process.startedAt),
    size: () => identities.size(),
  };
};

export const defaultUninspectableRegistry: UninspectableRegistry = createUninspectableRegistry();
