import { nodeFileSystem } from '@momonga/foundation';
import type { MarkerMode } from '@momonga/foundation';

export interface MarkerOwner {
  alive(): boolean;
}

export interface MarkerOwners {
  register(name: string, owner: MarkerOwner): void;
  transfer(name: string, owner: MarkerOwner): void;
  owned(): Set<string>;
  remember(name: string, mode: MarkerMode): void;
  modeOf(name: string): MarkerMode | undefined;
  forget(name: string): void;
}

export const createMarkerOwners = (): MarkerOwners => {
  const owners = new Map<string, MarkerOwner>();
  const modes = new Map<string, MarkerMode>();
  return {
    register: (name, owner) => void owners.set(name, owner),
    transfer: (name, owner) => void owners.set(name, owner),
    owned: () => {
      const living = new Set<string>();
      for (const [name, owner] of owners) {
        if (owner.alive()) living.add(name);
        else owners.delete(name);
      }
      return living;
    },
    remember: (name, mode) => void modes.set(name, mode),
    modeOf: (name) => modes.get(name),
    forget: (name) => {
      owners.delete(name);
      modes.delete(name);
    },
  };
};

export const unownedOf = (names: readonly string[], owners: MarkerOwners): string[] => {
  const living = owners.owned();
  return names.filter((name) => !living.has(name));
};

export const unsettledKeys = async (markerDir: string, owners: MarkerOwners): Promise<string[]> => {
  let names: string[];
  try {
    names = await nodeFileSystem.readdir(markerDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return unownedOf(names, owners);
};
