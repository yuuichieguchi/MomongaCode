import fs from 'node:fs';
import path from 'node:path';
import { O_SHLOCK } from './lock-capability.ts';
import type { LockCapabilityProbe } from './lock-capability.ts';
import type { MarkerState } from '../marker-state.ts';
import type { MarkerStateOptions, ProcessInspector, UninspectableProcess } from './inspector-types.ts';

export type BaseInspector = Omit<ProcessInspector, 'markerState'>;

const sharedProbeFlags = (): number => fs.constants.O_RDONLY | O_SHLOCK | fs.constants.O_NONBLOCK;

const raceAbort = async <T>(pending: Promise<T>, signal: AbortSignal): Promise<T | 'unknown'> => {
  let release: () => void = () => undefined;
  const aborted = new Promise<'unknown'>((resolve) => {
    release = () => resolve('unknown');
    if (signal.aborted) release();
    else signal.addEventListener('abort', release, { once: true });
  });
  try {
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', release);
  }
};

const lockState = async (marker: string): Promise<MarkerState> => {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(marker, sharedProbeFlags());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EAGAIN') return 'held';
    if (code === 'ENOENT') return 'free';
    return 'unknown';
  }
  await handle.close();
  return 'free';
};

const listedState = async (base: BaseInspector, marker: string, signal: AbortSignal): Promise<MarkerState> => {
  if (signal.aborted) return 'unknown';
  let uninspectable = false;
  const markUninspectable = (_process: UninspectableProcess): void => {
    uninspectable = true;
  };
  const listing = await base.holdersOf(marker, { signal }, markUninspectable);
  if (listing.kind === 'failed') return 'unknown';
  if (listing.kind === 'gone') return 'free';
  return listing.value.some((pid) => pid !== process.pid) || uninspectable ? 'held' : 'free';
};

export const withListedState = (base: BaseInspector): ProcessInspector => ({
  ...base,
  markerState: (marker, { signal }) => listedState(base, marker, signal),
});

export const withMarkerState = (base: ProcessInspector, capability: LockCapabilityProbe): ProcessInspector => {
  const locking = new Map<string, Promise<MarkerState>>();
  const viaLock = (marker: string): Promise<MarkerState> => {
    const running = locking.get(marker);
    if (running !== undefined) return running;
    const started = lockState(marker);
    locking.set(marker, started);
    const clear = (): void => void locking.delete(marker);
    started.then(clear, clear);
    return started;
  };
  return {
    ...base,
    capability,
    markerState: async (marker, { signal, mode }: MarkerStateOptions): Promise<MarkerState> => {
      if (signal.aborted) return 'unknown';
      const proved = (await raceAbort(capability.of(path.dirname(marker)), signal)) === 'proved';
      if (signal.aborted) return 'unknown';
      if (proved && mode !== 'listed') return raceAbort(viaLock(marker), signal);
      return base.markerState(marker, { signal });
    },
  };
};
