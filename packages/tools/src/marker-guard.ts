import path from 'node:path';
import { RETRY_KINDS, claimRetry, readAttemptRecord, reapMarkedProcessesWithReport } from '@momonga/foundation';
import type { AttemptRecord, MarkerState, ProcessInspector, ReapTiming, RetryKind, SignalSender, UninspectableRegistry } from '@momonga/foundation';
import { createMarkerSettle } from './marker-settle.ts';
import type { MarkerOwners } from './marker-owners.ts';
import { unsettledKeys } from './marker-owners.ts';

const KIND_WORDS: Record<RetryKind, string> = {
  guard: 'before the next command that runs a process or changes files',
  sweep: 'the periodic check',
  startup: 'start-up',
  shutdown: 'shutdown',
};

const triesLine = (record: AttemptRecord): string => {
  const unspent = RETRY_KINDS.filter((kind) => !record.spent[kind]);
  return unspent.length === 0
    ? 'MomongaCode has used its four retries and will not try again.'
    : `MomongaCode will try to stop it again at: ${unspent.map((kind) => KIND_WORDS[kind]).join(', ')}.`;
};

const ignoreLine = (name: string): string => `If it can stay running, ask the person to run /markers ignore ${name}.`;

export type MarkerGuardRefusal = 'settled' | 'interrupted' | 'unreadable';

export const refusalText = (variant: MarkerGuardRefusal, name: string, pids: string, record: AttemptRecord): string => {
  if (variant === 'unreadable') {
    return `Not run: MomongaCode could not check whether a process started by an earlier command (marker ${name}) is still running. ${triesLine(record)} Retry. ${ignoreLine(name)}`;
  }
  const subject = variant === 'settled' ? 'a process started by an earlier command' : 'a process started by an earlier command that was interrupted when MomongaCode stopped';
  return `Not run: ${subject} (marker ${name}, ${pids}) may still be running and could not be stopped. ${triesLine(record)} Stop it and retry. ${ignoreLine(name)}`;
};

export type MarkerGuardOptions = {
  markerDir: string;
  owners: MarkerOwners;
  settledRow(name: string): boolean;
  onWarning(message: string): void;
  inspector?: ProcessInspector;
  kill?: SignalSender;
  timing?: ReapTiming;
  killGraceMs: number;
  uninspectable?: UninspectableRegistry;
};

export type MarkerGuard = { check(signal: AbortSignal, except: string): Promise<string | undefined> };

export const createMarkerGuard = (guardOptions: MarkerGuardOptions): MarkerGuard => {
  const { markerDir, owners, inspector, kill, timing, killGraceMs, uninspectable, onWarning } = guardOptions;

  const settleOf = (marker: string) =>
    createMarkerSettle({
      marker,
      mode: owners.modeOf(path.basename(marker)) ?? 'listed',
      onWarning,
      ...(inspector === undefined ? {} : { inspector }),
      ...(kill === undefined ? {} : { kill }),
      ...(timing === undefined ? {} : { timing }),
      killGraceMs,
    });

  const variantOf = (name: string): MarkerGuardRefusal => (guardOptions.settledRow(name) || owners.modeOf(name) !== undefined ? 'settled' : 'interrupted');

  const settleKey = async (name: string, signal: AbortSignal): Promise<string | undefined> => {
    const marker = path.join(markerDir, name);
    let record: AttemptRecord;
    try {
      record = await readAttemptRecord(marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (record.ignored) return undefined;
    const settle = settleOf(marker);
    const state = await settle.state(signal);
    if (state === 'free') {
      await settle.remove();
      return undefined;
    }
    if (state === 'unknown') return refusalText('unreadable', name, 'unidentified', record);
    if (record.spent.guard) return refusalText(variantOf(name), name, 'unidentified', record);
    const claim = await claimRetry(marker, 'guard', { signal });
    if (claim === 'absent') return undefined;
    if (claim !== 'claimed') return refusalText(variantOf(name), name, 'unidentified', { ...record, spent: { ...record.spent, guard: true } });
    const report = await reapMarkedProcessesWithReport({
      marker,
      killGraceMs,
      label: 'tool',
      onWarning,
      signal,
      markerMode: owners.modeOf(name) ?? 'listed',
      ...(timing === undefined ? {} : { timing }),
      ...(kill === undefined ? {} : { kill }),
      ...(inspector === undefined ? {} : { inspector }),
      ...(uninspectable === undefined ? {} : { uninspectable }),
    });
    if (report.removed) return undefined;
    const after = await readAttemptRecord(marker);
    const settled = settleOf(marker);
    const remaining = await settled.state(signal);
    if (remaining === 'free') {
      await settled.remove();
      return undefined;
    }
    if (remaining === 'unknown') return refusalText('unreadable', name, 'unidentified', after);
    return refusalText(variantOf(name), name, 'unidentified', after);
  };

  return {
    check: async (signal, except) => {
      for (const name of (await unsettledKeys(markerDir, owners)).filter((candidate) => candidate !== except)) {
        const refusal = await settleKey(name, signal);
        if (refusal !== undefined) return refusal;
      }
      return undefined;
    },
  };
};
