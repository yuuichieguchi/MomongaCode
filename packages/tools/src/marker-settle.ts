import { UNNAMED_REASON, commandMayStillRun, refusedReason, defaultProcessInspector, groupAlive, groupPortOf, nodeFileSystem, findHolders, outlivedNotes, reconcileProcessGroup } from '@momonga/foundation';
import type { CommandLiveness, HolderListing, MarkerMode, MarkerReconcileResult, MarkerState, ProcessGroupPort, ProcessInspector, ReapTiming, SignalSender, UninspectableProcess } from '@momonga/foundation';

import { ToolExecutionError } from './types.ts';
import type { SpawnMarker, ToolContext } from './types.ts';

export type MarkerListing = { holders: number[]; refused: UninspectableProcess[] };

export interface MarkerSettle {
  state(signal: AbortSignal): Promise<MarkerState>;
  list(signal: AbortSignal): Promise<MarkerListing>;
  groupAlive(pgid: number, signal: AbortSignal): Promise<boolean>;
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
  groupPort?: ProcessGroupPort;
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

export const createMarkerSettle = ({ marker, mode, inspector = defaultProcessInspector(), killGraceMs, kill, groupPort, timing, onWarning }: MarkerSettleOptions): MarkerSettle => {
  let cached: MarkerState | undefined;
  const group = groupPortOf(groupPort, kill);
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
    groupAlive: (pgid, signal) => groupAlive(pgid, group, signal),
    reap: async (pgid, signal) => {
      cached = undefined;
      return reconcileProcessGroup(
        { pgid, marker },
        { signal, inspector, groupPort: group, ...(killGraceMs === undefined ? {} : { killGraceMs }), ...(kill === undefined ? {} : { kill }), ...(timing === undefined ? {} : { timing }) },
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

export const listingOf = async (settle: MarkerSettle, signal: AbortSignal): Promise<HolderListing> => {
  try {
    return { kind: 'listed', ...(await settle.list(signal)) };
  } catch (error) {
    return { kind: 'failed', reason: reasonOf(signal, error) };
  }
};

export const unnamedLivenessNotes = (exit: FinishedCommand['exit'], liveness: CommandLiveness, refused: readonly UninspectableProcess[]): string[] => {
  const finished = `Note: the command finished (${exitText(exit)}) and its output is above.`;
  if (liveness.answer === 'no') return [];
  if (liveness.answer === 'unknown') {
    if (liveness.basis === 'held') return [];
    return [`${finished} MomongaCode could not check whether a process started by it is still running (${liveness.reason}). Nothing was stopped. It will check again before the next command that runs a process or changes files in this session.`];
  }
  return [`${finished} At least one process started by it is still running and could not be identified or stopped (${refused.length > 0 ? refusedReason(refused) : UNNAMED_REASON}). Nothing else was stopped. MomongaCode will try to stop it again, at most once at each of: before the next command that runs a process or changes files, the periodic check, start-up and shutdown.`];
};

export const settleFinishedCommand = async (settle: MarkerSettle, { pgid, exit, signal }: FinishedCommand): Promise<string[]> => {
  const marker = await settle.state(signal);
  const listing = marker === 'held' ? await listingOf(settle, signal) : undefined;
  const named = listing?.kind === 'listed' && listing.holders.length > 0;
  const runnable = marker === 'held' && listing?.kind === 'listed' && !named ? await settle.groupAlive(pgid, signal) : undefined;
  const liveness = commandMayStillRun({ marker, ...(listing === undefined ? {} : { listing }), ...(runnable === undefined ? {} : { group: { kind: 'read', runnable } }) });
  if (liveness.answer !== 'yes' || !named) return unnamedLivenessNotes(exit, liveness, listing?.kind === 'listed' ? listing.refused : []);
  const reaped = await settle.reap(pgid, signal);
  await settle.state(signal);
  return outlivedNotes(reaped, 'command');
};

export const requireSpawnMarker = (ctx: ToolContext, toolName: string): Promise<SpawnMarker> => {
  if (ctx.spawnMarker === undefined) throw new ToolExecutionError(`${toolName} needs a process marker from the executor`);
  return ctx.spawnMarker();
};
