import { UNMEASURED_CAPABILITY, createMarker } from '@momonga/foundation';
import type { LockCapabilityProbe, MarkerMode } from '@momonga/foundation';
import { removeMarkerFile } from '@momonga/tools';

export type JobMarkerFiles = {
  create<T>(marker: string, use: (markerFd: number, mode: MarkerMode) => T): Promise<T>;
  remove(marker: string, onWarning: (message: string) => void): Promise<void>;
};

export const createNodeJobMarkerFiles = (capability: LockCapabilityProbe = UNMEASURED_CAPABILITY): JobMarkerFiles => ({
  create: async (marker, use) => {
    const handle = await createMarker(marker, { capability });
    try {
      return use(handle.fd, handle.mode);
    } finally {
      handle.close();
    }
  },
  remove: (marker, onWarning) => removeMarkerFile(marker, onWarning),
});
