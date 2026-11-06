import fs from 'node:fs';
import { UNMEASURED_CAPABILITY, createMarker } from '@momonga/foundation';
import type { LockCapabilityProbe } from '@momonga/foundation';

export type JobMarkerFiles = {
  create<T>(marker: string, use: (markerFd: number) => T): Promise<T>;
  remove(marker: string): void;
};

export const createNodeJobMarkerFiles = (capability: LockCapabilityProbe = UNMEASURED_CAPABILITY): JobMarkerFiles => ({
  create: async (marker, use) => {
    const handle = await createMarker(marker, { capability });
    try {
      return use(handle.fd);
    } finally {
      handle.close();
    }
  },
  remove: (marker) => {
    fs.rmSync(marker, { force: true });
  },
});
