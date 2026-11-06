import { defaultProcessInspector, nodeFileSystem, findHolders, reconcileProcessGroup } from '@momonga/foundation';
import type { MarkerMode, MarkerReconcileResult, MarkerState, ProcessInspector, ReapTiming, SignalSender, UninspectableProcess } from '@momonga/foundation';

export type MarkerListing = { holders: number[]; refused: UninspectableProcess[] };

export interface MarkerSettle {
  state(signal: AbortSignal): Promise<MarkerState>;
  list(signal: AbortSignal): Promise<MarkerListing>;
  reap(pgid: number, signal: AbortSignal): Promise<MarkerReconcileResult>;
  readonly mode: MarkerMode;
  cached(): MarkerState | undefined;
  remove(): Promise<void>;
  discard(): Promise<void>;
}

export type MarkerSettleOptions = {
  marker: string;
  mode: MarkerMode;
  inspector?: ProcessInspector;
  killGraceMs?: number;
  kill?: SignalSender;
  timing?: ReapTiming;
  onWarning(message: string): void;
};

export const removeMarkerFile = async (marker: string, onWarning: (message: string) => void): Promise<void> => {
  try {
    await nodeFileSystem.rm(marker);
  } catch (error) {
    onWarning(`the process marker ${marker} could not be removed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const createMarkerSettle = ({ marker, mode, inspector = defaultProcessInspector(), killGraceMs, kill, timing, onWarning }: MarkerSettleOptions): MarkerSettle => {
  let cached: MarkerState | undefined;
  const removeFile = (): Promise<void> => removeMarkerFile(marker, onWarning);
  return {
    mode,
    cached: () => cached,
    state: async (signal) => {
      cached ??= await inspector.markerState(marker, { signal, mode });
      return cached;
    },
    list: async (signal) => {
      const refused: UninspectableProcess[] = [];
      const holders = await findHolders(marker, { signal, inspector, onUninspectable: (process) => void refused.push(process) });
      return { holders, refused };
    },
    reap: async (pgid, signal) => {
      cached = undefined;
      return reconcileProcessGroup(
        { pgid, marker },
        { signal, inspector, ...(killGraceMs === undefined ? {} : { killGraceMs }), ...(kill === undefined ? {} : { kill }), ...(timing === undefined ? {} : { timing }) },
      );
    },
    remove: async () => {
      if (cached !== 'free') return;
      await removeFile();
    },
    discard: removeFile,
  };
};

const exitText = (exit: { code: number | null; signal: string | null }): string => (exit.code === null ? `terminated by ${exit.signal ?? 'a signal'}` : `exit code ${exit.code}`);

const reasonOf = (signal: AbortSignal, failure: unknown): string => {
  if (signal.aborted) return 'the call ended before the check finished';
  if (failure instanceof Error) return failure.message;
  return 'the holder check failed';
};

export type FinishedCommand = { pgid: number; exit: { code: number | null; signal: string | null }; signal: AbortSignal };

export const settleFinishedCommand = async (settle: MarkerSettle, { pgid, exit, signal }: FinishedCommand): Promise<string[]> => {
  const finished = `Note: the command finished (${exitText(exit)}) and its output is above.`;
  const first = await settle.state(signal);
  if (first === 'free') return [];
  if (first === 'unknown') {
    return [`${finished} MomongaCode could not check whether a process started by it is still running (${reasonOf(signal, undefined)}). Nothing was stopped. It will check again before the next command that runs a process or changes files in this session.`];
  }
  let listing: MarkerListing;
  try {
    listing = await settle.list(signal);
  } catch (error) {
    return [`${finished} At least one process started by it is still running and could not be identified or stopped (${reasonOf(signal, error)}). Nothing else was stopped. MomongaCode will try to stop it again, at most once at each of: before the next command that runs a process or changes files, the periodic check, start-up and shutdown.`];
  }
  if (listing.holders.length === 0) {
    const named = listing.refused.map(({ pid, command }) => `${pid} (${command})`).join(', ');
    const reason = listing.refused.length === 0 ? 'no process could be named' : `process ${named} could not be inspected`;
    return [`${finished} At least one process started by it is still running and could not be identified or stopped (${reason}). Nothing else was stopped. MomongaCode will try to stop it again, at most once at each of: before the next command that runs a process or changes files, the periodic check, start-up and shutdown.`];
  }
  const reaped = await settle.reap(pgid, signal);
  await settle.state(signal);
  return [
    `Terminated ${listing.holders.length} process(es) that outlived the command.`,
    ...(reaped.unsignalledPids.length === 0 ? [] : [`Could not signal process ${reaped.unsignalledPids.join(', ')}.`]),
  ];
};
