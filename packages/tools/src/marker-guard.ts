import path from 'node:path';
import { RETRY_KINDS, claimRetry, commandMayStillRun, markerRemedyText, readAttemptRecord, readMarkerGroup, reapMarkedProcessesWithReport } from '@momonga/foundation';
import type { AttemptRecord, CommandLiveness, GroupLiveness, MarkerState, ProcessGroupPort, ProcessInspector, Timing, RetryKind, SignalSender, UninspectableRegistry } from '@momonga/foundation';
import { createMarkerSettle, listingOf } from './marker-settle.ts';
import type { MarkerSettle } from './marker-settle.ts';
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

const remedyLine = (name: string, group: number | undefined): string => markerRemedyText({ surface: 'any', name, group, addressed: 'model' });

export type MarkerGuardRefusal = 'settled' | 'interrupted';

export const refusalText = (variant: MarkerGuardRefusal, name: string, group: number | undefined, record: AttemptRecord): string => {
  const subject = variant === 'settled' ? 'a process started by an earlier command' : 'a process started by an earlier command that was interrupted when MomongaCode stopped';
  return `Not run: ${subject} (marker ${name}) may still be running and could not be stopped. ${triesLine(record)} ${remedyLine(name, group)} Then retry.`;
};

const finalNoticeText = (name: string, group: number | undefined): string =>
  `Note: a process started by an earlier command (marker ${name}) may still be running. MomongaCode has used its four retries and will not try again. ${remedyLine(name, group)}`;

const uncheckedText = (name: string, reason: string): string =>
  `Note: MomongaCode could not check whether a process started by an earlier command (marker ${name}) is still running (${reason}). The command ran. It will check again before the next command that runs a process or changes files in this session.`;

export type MarkerLedgerRow = { settled: boolean };

export type MarkerGuardOptions = {
  markerDir: string;
  owners: MarkerOwners;
  ledgerRow(name: string): MarkerLedgerRow;
  onWarning(message: string): void;
  inspector: ProcessInspector;
  kill?: SignalSender;
  groupPort?: ProcessGroupPort;
  timing?: Timing;
  killGraceMs: number;
  uninspectable?: UninspectableRegistry;
};

export type MarkerGuardVerdict = { kind: 'clear' } | { kind: 'refuse'; text: string } | { kind: 'note'; text: string };

export type MarkerGuard = { check(signal: AbortSignal, except: string): Promise<MarkerGuardVerdict> };

const CLEAR: MarkerGuardVerdict = { kind: 'clear' };

const allSpent = (record: AttemptRecord): boolean => RETRY_KINDS.every((kind) => record.spent[kind]);

export const createMarkerGuard = (guardOptions: MarkerGuardOptions): MarkerGuard => {
  const { markerDir, owners, inspector, kill, groupPort, timing, killGraceMs, uninspectable, onWarning } = guardOptions;

  const settleOf = (marker: string): MarkerSettle =>
    createMarkerSettle({
      marker,
      mode: owners.modeOf(path.basename(marker)) ?? 'listed',
      onWarning,
      inspector,
      ...(kill === undefined ? {} : { kill }),
      ...(groupPort === undefined ? {} : { groupPort }),
      ...(timing === undefined ? {} : { timing }),
      killGraceMs,
    });

  const variantOf = (name: string): MarkerGuardRefusal => (guardOptions.ledgerRow(name).settled || owners.modeOf(name) !== undefined ? 'settled' : 'interrupted');

  const groupOf = async (pgid: number | undefined, settle: MarkerSettle, signal: AbortSignal): Promise<GroupLiveness> =>
    pgid === undefined ? { kind: 'unrecorded' } : { kind: 'read', runnable: await settle.groupAlive(pgid, signal) };

  const verdictOf = (name: string, marker: MarkerState, liveness: CommandLiveness, record: AttemptRecord, pgid: number | undefined): MarkerGuardVerdict => {
    if (liveness.answer === 'yes') return { kind: 'refuse', text: refusalText(variantOf(name), name, pgid, record) };
    if (marker === 'held' && allSpent(record)) return { kind: 'note', text: finalNoticeText(name, pgid) };
    if (liveness.answer === 'unknown' && liveness.basis === 'unchecked') return { kind: 'note', text: uncheckedText(name, liveness.reason) };
    return CLEAR;
  };

  const observe = async (name: string, settle: MarkerSettle, state: MarkerState, record: AttemptRecord, signal: AbortSignal): Promise<MarkerGuardVerdict> => {
    const pgid = state === 'held' ? await readMarkerGroup(path.join(markerDir, name)) : undefined;
    const group = state === 'held' ? await groupOf(pgid, settle, signal) : undefined;
    const runnable = group?.kind === 'read' && group.runnable;
    const listing = state === 'held' && !runnable && !allSpent(record) ? await listingOf(settle, signal) : undefined;
    const liveness = commandMayStillRun({ marker: state, ...(listing === undefined ? {} : { listing }), ...(group === undefined ? {} : { group }) });
    return verdictOf(name, state, liveness, record, pgid);
  };

  const afterAttempt = async (name: string, marker: string, record: AttemptRecord, signal: AbortSignal): Promise<MarkerGuardVerdict> => {
    const settle = settleOf(marker);
    const state = await settle.state(signal);
    if (state === 'free') {
      await settle.remove();
      return CLEAR;
    }
    return observe(name, settle, state, record, signal);
  };

  const settleKey = async (name: string, signal: AbortSignal): Promise<MarkerGuardVerdict> => {
    const marker = path.join(markerDir, name);
    let record: AttemptRecord;
    try {
      record = await readAttemptRecord(marker);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return CLEAR;
      throw error;
    }
    if (record.ignored) return CLEAR;
    const settle = settleOf(marker);
    const state = await settle.state(signal);
    if (state === 'free') {
      await settle.remove();
      return CLEAR;
    }
    if (state === 'unknown' || record.spent.guard) return observe(name, settle, state, record, signal);
    const claim = await claimRetry(marker, 'guard', { signal });
    if (claim === 'absent') return CLEAR;
    if (claim !== 'claimed') return observe(name, settle, state, { ...record, spent: { ...record.spent, guard: true } }, signal);
    const report = await reapMarkedProcessesWithReport({
      marker,
      killGraceMs,
      label: 'tool',
      onWarning,
      signal,
      markerMode: owners.modeOf(name) ?? 'listed',
      ...(timing === undefined ? {} : { timing }),
      ...(kill === undefined ? {} : { kill }),
      ...(groupPort === undefined ? {} : { groupPort }),
      inspector,
      ...(uninspectable === undefined ? {} : { uninspectable }),
    });
    if (report.removed) return CLEAR;
    return afterAttempt(name, marker, await readAttemptRecord(marker), signal);
  };

  return {
    check: async (signal, except) => {
      const notes: string[] = [];
      for (const name of (await unsettledKeys(markerDir, owners)).filter((candidate) => candidate !== except)) {
        const verdict = await settleKey(name, signal);
        if (verdict.kind === 'refuse') return verdict;
        if (verdict.kind === 'note') notes.push(verdict.text);
      }
      return notes.length === 0 ? CLEAR : { kind: 'note', text: notes.join('\n') };
    },
  };
};
