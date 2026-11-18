import type { Dirent, Stats } from 'node:fs';
import path from 'node:path';
import type { SignalSender } from './process-alive.ts';
import { groupPortOf, hostAsyncSignalSender } from './platform/group-port.ts';
import type { AsyncSignalSender, GroupProbeOptions, GroupSignalOutcome, ProcessGroupPort } from './platform/group-port.ts';
import type { MarkerMode, MarkerState } from './marker-state.ts';
import { commandMayStillRun } from './command-liveness.ts';
import { ProbeFailedError, valueOrThrow } from './platform/inspector-types.ts';
import { OPEN_FLAGS, nodeFileSystem } from './node-file-system.ts';
import { operationSignal } from './platform/probe-timing.ts';
import type { ProbeResult, ProcessInspector, StartTime, UninspectableProcess } from './platform/inspector-types.ts';
import { defaultUninspectableRegistry } from './uninspectable-registry.ts';
import type { UninspectableRegistry } from './uninspectable-registry.ts';
import { KILL_CONFIRM_MS, REAP_KILL_GRACE_MS, markerReapClockBoundMs } from './process-contract.ts';
import { systemWaitTiming } from './system-timing.ts';
import { sleep } from './timing.ts';
import type { Timing } from './timing.ts';
import { POLL_INTERVAL_MS, waitUntil } from './wait-until.ts';
import { RETRY_KINDS, claimRetry, isMalformedRecord, nodeRecordFiles, parseAttemptRecord, parseRecordedGroup, parseRecordedGroupName, readMarkerGroup, readRecordText } from './platform/marker-record.ts';
import type { AttemptRecord, RetryKind } from './platform/marker-record.ts';

const asyncSenderOf = (kill: SignalSender | undefined): AsyncSignalSender =>
  kill === undefined
    ? hostAsyncSignalSender
    : async (target, signal) => {
        kill(target, signal);
      };

export type FindHoldersOptions = { signal: AbortSignal; inspector: ProcessInspector; onUninspectable?: (process: UninspectableProcess) => void };

export const findHolders = async (marker: string, { signal, inspector, onUninspectable }: FindHoldersOptions): Promise<number[]> =>
  valueOrThrow(`listing the holders of ${marker}`, await inspector.holdersOf(marker, { signal }, onUninspectable), []).filter((pid) => pid !== process.pid);

const uninspectableWarning = (context: string, processes: readonly UninspectableProcess[]): string =>
  `${context}: process ${processes.map((process) => `${process.pid} (${process.command})`).join(', ')} could not be inspected, so it was left alone`;

export const reportUninspectableOnce =
  (onWarning: (message: string) => void, context: string, registry: UninspectableRegistry = defaultUninspectableRegistry) =>
  (process: UninspectableProcess): void => {
    if (registry.firstNaming(context, process)) onWarning(uninspectableWarning(context, [process]));
  };

const groupsByHolder = async (holders: readonly number[], candidateGroups: readonly number[], inspector: ProcessInspector, signal: AbortSignal): Promise<Map<number, number>> =>
  valueOrThrow(`reading the process groups of ${holders.join(',')}`, await inspector.groupsOf(holders, candidateGroups, { signal }), new Map<number, number>());

type Identity = { pid: number; startedAt: StartTime };

type PassReads = {
  startTime(pid: number): Promise<ProbeResult<StartTime>>;
  groups(pids: readonly number[], candidateGroups: readonly number[]): Promise<Map<number, number>>;
};

const sweepReads = (inspector: ProcessInspector, stop: AbortSignal): PassReads => ({
  startTime: (pid) => inspector.startTimeOf(pid, { signal: stop }),
  groups: (pids, candidateGroups) => groupsByHolder(pids, candidateGroups, inspector, stop),
});

const messageOfReason = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

const endedByAsker = (stop: AbortSignal): boolean => stop.aborted;

const errorOf = (thrown: unknown): Error => (thrown instanceof Error ? thrown : new Error(String(thrown)));

class StopUnreadable extends Error {
  readonly failure: Error;
  readonly reason: string;

  constructor(failure: Error, stop: AbortSignal) {
    super(failure.message);
    this.name = 'StopUnreadable';
    this.failure = failure;
    this.reason = endedByAsker(stop) ? messageOfReason(stop.reason) : failure.message;
  }
}

const setReadOrEnd = async <T>(stop: AbortSignal, read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (error) {
    throw new StopUnreadable(errorOf(error), stop);
  }
};

type Identified = { identities: Identity[]; unreadable: number[] };

const identify = async (pids: readonly number[], reads: PassReads): Promise<Identified> => {
  const identities: Identity[] = [];
  const unreadable: number[] = [];
  for (const pid of pids) {
    const read = await reads.startTime(pid);
    if (read.kind === 'value') identities.push({ pid, startedAt: read.value });
    else if (read.kind === 'failed') unreadable.push(pid);
  }
  return { identities, unreadable };
};

type HolderSplit = { inGroup: Identity[]; outsideGroup: Identity[]; unreadable: number[] };

const splitByGroup = async (holders: readonly number[], pgid: number, reads: PassReads): Promise<HolderSplit> => {
  const { identities, unreadable } = await identify(holders, reads);
  if (identities.length === 0) return { inGroup: [], outsideGroup: [], unreadable };
  const groups = await reads.groups(identities.map(({ pid }) => pid), [pgid]);
  return {
    inGroup: identities.filter(({ pid }) => groups.get(pid) === pgid),
    outsideGroup: identities.filter(({ pid }) => groups.has(pid) && groups.get(pid) !== pgid),
    unreadable,
  };
};

type Listing = { inspector: ProcessInspector; timing: Timing; signal: AbortSignal };

type HolderList = { holders: number[]; refusing: Map<number, UninspectableProcess> };

const holdersUntil = async (marker: string, listing: Listing, deadline: number, unsettled?: Map<number, UninspectableProcess>, observed?: UninspectableProcess[]): Promise<number[]> => {
  const { inspector, timing, signal } = listing;
  const ended = (): boolean => timing.monotonicMs() >= deadline || signal.aborted;
  const list = async (): Promise<HolderList> => {
    const refusing = new Map<number, UninspectableProcess>();
    const holders = await findHolders(marker, { signal, inspector, onUninspectable: (process) => void refusing.set(process.pid, process) });
    return { holders, refusing };
  };
  const settledList = async (): Promise<HolderList | undefined> => {
    let listed: HolderList;
    try {
      listed = await list();
    } catch (error) {
      if (error instanceof ProbeFailedError && error.probeCause === 'transient' && !ended()) return undefined;
      throw error;
    }
    return unsettled === undefined || listed.refusing.size === 0 || listed.holders.length > 0 || ended() ? listed : undefined;
  };
  const waited = await waitUntil(timing, settledList, { intervalMs: POLL_INTERVAL_MS, deadline, signal });
  const { holders, refusing } = waited.kind === 'found' ? waited.value : await list();
  unsettled?.clear();
  for (const [pid, process] of refusing) unsettled?.set(pid, process);
  observed?.push(...refusing.values());
  return holders;
};

export const holderGroups = async (
  holders: readonly number[],
  candidateGroups: readonly number[] = [],
  { signal, inspector }: { signal: AbortSignal; inspector: ProcessInspector },
): Promise<number[]> => [...(await groupsByHolder(holders, candidateGroups, inspector, signal)).values()];

type ProvedTarget = { group: number | undefined; proof: readonly Identity[] };

const ownProof = (identity: Identity): ProvedTarget => ({ group: undefined, proof: [identity] });

const groupTarget = (pgid: number, proof: readonly Identity[], alive: boolean): ProvedTarget[] => (alive && proof.length > 0 ? [{ group: pgid, proof }] : []);

type SignalPass = { sent: number[]; stoppedHolders: number[]; unsignalled: number[]; unreadable: number[] };

type Deliver = (target: number, signal: NodeJS.Signals, options: GroupProbeOptions) => Promise<GroupSignalOutcome>;

const deliverBy =
  (send: AsyncSignalSender): Deliver =>
  async (target, signal, options) => {
    try {
      await send(target, signal, options);
      return 'sent';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM') return 'denied';
      if (code === 'ESRCH') return 'gone';
      throw error;
    }
  };

const sendCounted = async (deliver: Deliver, target: number, signal: NodeJS.Signals, stop: AbortSignal, pass: SignalPass): Promise<void> => {
  pass.sent.push(target);
  if ((await deliver(target, signal, { signal: stop })) === 'denied') pass.unsignalled.push(Math.abs(target));
};

type ProvedSignal = { send: AsyncSignalSender; reads: PassReads; stop: AbortSignal; group?: ProcessGroupPort };

const groupDeliverOf = (group: ProcessGroupPort): Deliver => (target, signal, options) => group.signal(Math.abs(target), signal, options);

const startUnchanged = async ({ pid, startedAt }: Identity, reads: PassReads, pass: SignalPass): Promise<boolean> => {
  const read = await reads.startTime(pid);
  if (read.kind === 'failed') pass.unreadable.push(pid);
  return read.kind === 'value' && read.value === startedAt;
};

const signalHolder = async ({ send, stop }: ProvedSignal, pid: number, signal: NodeJS.Signals, pass: SignalPass): Promise<void> => {
  pass.stoppedHolders.push(pid);
  await sendCounted(deliverBy(send), pid, signal, stop, pass);
};

const signalGroupTarget = async (proved: ProvedSignal, group: number, proof: readonly Identity[], signal: NodeJS.Signals, pass: SignalPass): Promise<void> => {
  const { reads, stop } = proved;
  const deliver = proved.group === undefined ? deliverBy(proved.send) : groupDeliverOf(proved.group);
  for (const identity of proof) {
    if (!(await startUnchanged(identity, reads, pass))) continue;
    const groupNow = (await reads.groups([identity.pid], [group])).get(identity.pid);
    if (groupNow === group) {
      pass.stoppedHolders.push(...proof.map(({ pid }) => pid));
      await sendCounted(deliver, -group, signal, stop, pass);
      return;
    }
    if (groupNow !== undefined) await signalHolder(proved, identity.pid, signal, pass);
  }
};

const signalProved = async (proved: ProvedSignal, targets: readonly ProvedTarget[], signal: NodeJS.Signals, passes: SignalPass[] = []): Promise<SignalPass> => {
  const pass: SignalPass = { sent: [], stoppedHolders: [], unsignalled: [], unreadable: [] };
  passes.push(pass);
  for (const { group, proof } of targets) {
    if (group !== undefined) await signalGroupTarget(proved, group, proof, signal, pass);
    else for (const identity of proof) if (await startUnchanged(identity, proved.reads, pass)) await signalHolder(proved, identity.pid, signal, pass);
  }
  return pass;
};

const holdersOutsideGroup = async (holders: readonly number[], pgid: number, reads: PassReads): Promise<number[]> => {
  if (holders.length === 0) return [];
  const groups = await reads.groups(holders, [pgid]);
  return holders.filter((pid) => groups.has(pid) && groups.get(pid) !== pgid);
};

const holdersUntilNone = async (marker: string, listing: Listing, deadline: number, unsettled: Map<number, UninspectableProcess> | undefined, stillUnsettled: () => boolean): Promise<number[]> => {
  let last: number[] = [];
  const noneLeft = async (): Promise<number[] | undefined> => {
    last = await holdersUntil(marker, listing, deadline, unsettled);
    return last.length > 0 || stillUnsettled() ? undefined : last;
  };
  await waitUntil(listing.timing, noneLeft, { intervalMs: POLL_INTERVAL_MS, deadline, signal: listing.signal });
  return last;
};

const holdersAfterWindow = async (marker: string, listing: Listing, windowMs: number, unsettled: Map<number, UninspectableProcess> | undefined): Promise<number[]> => {
  const deadline = listing.timing.monotonicMs() + windowMs;
  return holdersUntilNone(marker, listing, deadline, unsettled, () => (unsettled?.size ?? 0) > 0);
};

type ReconcileReads = PassReads & {
  groupRunnable(pgid: number): Promise<boolean>;
  markerState(): Promise<MarkerState>;
  holders(withinMs: number, observed?: UninspectableProcess[]): Promise<number[]>;
  holdersAfterWindow(windowMs: number): Promise<number[]>;
};

type ReconcileReadsOf = {
  marker: string;
  markerMode: MarkerMode | undefined;
  inspector: ProcessInspector;
  group: ProcessGroupPort;
  timing: Timing;
  stop: AbortSignal;
  unsettled: Map<number, UninspectableProcess> | undefined;
};

const stopReads = ({ marker, markerMode, inspector, group, timing, stop, unsettled }: ReconcileReadsOf): ReconcileReads => {
  const listing: Listing = { inspector, timing, signal: stop };
  return {
    startTime: async (pid) => {
      const read = await setReadOrEnd(stop, () => inspector.startTimeOf(pid, { signal: stop }));
      if (read.kind === 'failed' && endedByAsker(stop)) throw new StopUnreadable(new ProbeFailedError(`reading the start time of ${pid}`, read), stop);
      return read;
    },
    groups: (pids, candidateGroups) => setReadOrEnd(stop, () => groupsByHolder(pids, candidateGroups, inspector, stop)),
    groupRunnable: (pgid) => setReadOrEnd(stop, () => group.alive(pgid, { signal: stop })),
    markerState: async () => {
      const state = await setReadOrEnd(stop, () => inspector.markerState(marker, { signal: stop, ...(markerMode === undefined ? {} : { mode: markerMode }) }));
      if (state === 'unknown' && endedByAsker(stop)) throw new StopUnreadable(new Error(`reading the marker state of ${marker} was ended`), stop);
      return state;
    },
    holders: (withinMs, observed) => setReadOrEnd(stop, () => holdersUntil(marker, listing, timing.monotonicMs() + withinMs, unsettled, observed)),
    holdersAfterWindow: (windowMs) => setReadOrEnd(stop, () => holdersAfterWindow(marker, listing, windowMs, unsettled)),
  };
};

export type MarkerReconcileResult = {
  outcome: 'unknown';
  output: string;
  stopped: boolean;
  stoppedHolders: number[];
  leftAloneGroup?: number;
  leftAlonePids: number[];
  unsignalledPids: number[];
};

type StructuredFindings = { stoppedHolders?: number[]; leftAloneGroup?: number; leftAlonePids?: number[]; unsignalledPids?: number[] };

const findingNotes = ({ leftAloneGroup, leftAlonePids = [], unsignalledPids = [] }: StructuredFindings): string[] => {
  const leftAlone = [...(leftAloneGroup === undefined ? [] : [`group ${leftAloneGroup}`]), ...leftAlonePids.map((pid) => `process ${pid}`)];
  return [
    ...(unsignalledPids.length === 0 ? [] : [`Could not signal process ${unsignalledPids.join(', ')}.`]),
    ...(leftAlone.length === 0 ? [] : [`Still running but no longer verified as belonging to this call, so left alone: ${leftAlone.join(', ')}.`]),
  ];
};

export const outlivedNotes = (result: MarkerReconcileResult, subject: string): string[] => [
  ...(result.stoppedHolders.length === 0 ? [] : [`Terminated ${result.stoppedHolders.length} process(es) that outlived the ${subject}.`]),
  ...findingNotes(result),
];

const unknownResult = (detail: string, stopped: boolean, { stoppedHolders = [], leftAloneGroup, leftAlonePids = [], unsignalledPids = [] }: StructuredFindings = {}): MarkerReconcileResult => ({
  outcome: 'unknown',
  output: `${detail} The effect of the interrupted command is unknown; inspect the current state before retrying it.`,
  stopped,
  stoppedHolders,
  ...(leftAloneGroup === undefined ? {} : { leftAloneGroup }),
  leftAlonePids,
  unsignalledPids,
});

export const stoppedCommandResult = (): MarkerReconcileResult => unknownResult('The interrupted command was stopped.', true);

const NONE_VERIFIED = 'No process of the interrupted command could be verified as belonging to this call, so none was signalled.';

export type ReconcileProcessGroupOptions = {
  killGraceMs?: number;
  kill?: SignalSender;
  groupPort?: ProcessGroupPort;
  timing?: Timing;
  signal?: AbortSignal | undefined;
  inspector: ProcessInspector;
  unsettled?: Map<number, UninspectableProcess>;
  markerMode?: MarkerMode;
};

type ReconcileEnd = { kind: 'listed'; result: MarkerReconcileResult; lastHolders: number[] } | { kind: 'unlisted'; failure: Error; reason: string; signalled: boolean; stoppedHolders: number[] };

const couldNotCheckResult = (reason: string, signalled: boolean, stoppedHolders: number[]): MarkerReconcileResult =>
  unknownResult(`MomongaCode could not check whether a process started by the interrupted command is still running (${reason}).${signalled ? '' : ' Nothing was stopped.'}`, signalled, { stoppedHolders });

const unlistedResult = ({ reason, signalled, stoppedHolders }: Extract<ReconcileEnd, { kind: 'unlisted' }>): MarkerReconcileResult => couldNotCheckResult(reason, signalled, stoppedHolders);

export type RecalledGroup = 'named' | 'unknown';

export const recallMarkerGroup = async (group: ProcessGroupPort, marker: string, pgid: number): Promise<RecalledGroup> => {
  const { names } = group;
  if (names === undefined) return 'named';
  let text: string;
  try {
    text = await nodeRecordFiles.read(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return names.nameOf(pgid) === undefined ? 'unknown' : 'named';
    throw error;
  }
  const name = parseRecordedGroupName(text);
  if (name === undefined || parseRecordedGroup(text) !== pgid) return names.nameOf(pgid) === undefined ? 'unknown' : 'named';
  names.recall(pgid, name);
  return 'named';
};

const unknownGroupResult = (pgid: number): MarkerReconcileResult =>
  unknownResult([`The marker records no name for group ${pgid}, and this process did not start it, so its processes cannot be proved and none was signalled.`, ...findingNotes({ leftAloneGroup: pgid })].join(' '), false, { leftAloneGroup: pgid });

export const reconcileProcessGroup = async (
  recorded: { pgid: number; marker: string },
  { killGraceMs = REAP_KILL_GRACE_MS, kill, groupPort, timing = systemWaitTiming, signal, inspector, unsettled, markerMode }: ReconcileProcessGroupOptions,
): Promise<MarkerReconcileResult> => {
  const operation = operationSignal(signal);
  try {
    const group = groupPortOf(groupPort, kill);
    if ((await recallMarkerGroup(group, recorded.marker, recorded.pgid)) === 'unknown') return unknownGroupResult(recorded.pgid);
    const end = await reconcileWithin(recorded, { killGraceMs, kill, group, timing, stop: operation.signal, inspector, unsettled, markerMode });
    return end.kind === 'listed' ? end.result : unlistedResult(end);
  } finally {
    operation.end();
  }
};

type ReconcileWithin = {
  killGraceMs: number;
  kill: SignalSender | undefined;
  group: ProcessGroupPort;
  timing: Timing;
  stop: AbortSignal;
  inspector: ProcessInspector;
  unsettled: Map<number, UninspectableProcess> | undefined;
  markerMode: MarkerMode | undefined;
};

const reconcileWithin = async (recorded: { pgid: number; marker: string }, options: ReconcileWithin): Promise<ReconcileEnd> => {
  const passes: SignalPass[] = [];
  try {
    return await reconcilePasses(recorded, options, passes);
  } catch (error) {
    if (!(error instanceof StopUnreadable)) throw error;
    return {
      kind: 'unlisted',
      failure: error.failure,
      reason: error.reason,
      signalled: passes.some(({ sent }) => sent.length > 0),
      stoppedHolders: [...new Set(passes.flatMap(({ stoppedHolders }) => stoppedHolders))],
    };
  }
};

const reconcilePasses = async (
  recorded: { pgid: number; marker: string },
  { killGraceMs, kill, group, timing, stop, inspector, unsettled, markerMode }: ReconcileWithin,
  passes: SignalPass[],
): Promise<ReconcileEnd> => {
  const { pgid, marker } = recorded;
  const reads = stopReads({ marker, markerMode, inspector, group, timing, stop, unsettled });
  const groupRunning = (): Promise<boolean> => reads.groupRunnable(pgid);
  const listed = (end: MarkerReconcileResult, lastHolders: number[]): ReconcileEnd => ({ kind: 'listed', result: end, lastHolders });
  const refused: UninspectableProcess[] = [];
  const holders = await reads.holders(killGraceMs, refused);
  const groupAlive = await groupRunning();
  if (holders.length === 0) {
    const liveness = commandMayStillRun({
      marker: await reads.markerState(),
      listing: { kind: 'listed', holders, refused },
      group: { kind: 'read', runnable: groupAlive },
    });
    if (liveness.answer === 'no') return listed(unknownResult('The interrupted command is no longer running.', false), []);
    if (liveness.answer === 'unknown') return listed(couldNotCheckResult(liveness.reason, false, []), []);
    return listed(unknownResult([NONE_VERIFIED, ...findingNotes({ leftAloneGroup: pgid })].join(' '), false, { leftAloneGroup: pgid }), []);
  }
  const proved: ProvedSignal = { send: asyncSenderOf(kill), reads, stop, group };
  const first = await splitByGroup(holders, pgid, reads);
  const termPass = await signalProved(proved, [...groupTarget(pgid, first.inGroup, groupAlive), ...first.outsideGroup.map(ownProof)], 'SIGTERM', passes);
  const unsignalled = new Set(termPass.unsignalled);
  const waitEnded = (): ReconcileEnd =>
    listed(
      unknownResult('The interrupted command was sent SIGTERM; the wait for it ended with its operation before its exit could be confirmed.', termPass.sent.length > 0, {
        stoppedHolders: [...new Set(termPass.stoppedHolders)],
        leftAlonePids: [...new Set([...first.unreadable, ...termPass.unreadable])],
        unsignalledPids: [...unsignalled],
      }),
      holders,
    );
  await sleep(timing, killGraceMs, stop);
  if (stop.aborted) return waitEnded();

  const remaining = await reads.holders(killGraceMs);
  if (stop.aborted) return waitEnded();
  const second = await splitByGroup(remaining, pgid, reads);
  const stillInGroup = second.inGroup.length > 0 && (await groupRunning());
  const killPass = await signalProved(proved, [...groupTarget(pgid, second.inGroup, stillInGroup), ...second.outsideGroup.map(ownProof)], 'SIGKILL', passes);
  for (const pid of killPass.unsignalled) unsignalled.add(pid);

  const leftAloneGroup = !killPass.sent.includes(-pgid) && (await groupRunning()) ? pgid : undefined;
  const lastHolders = await reads.holdersAfterWindow(KILL_CONFIRM_MS);
  const outsideAfter = await holdersOutsideGroup(lastHolders, pgid, reads);
  const findings: StructuredFindings = {
    stoppedHolders: [...new Set([...termPass.stoppedHolders, ...killPass.stoppedHolders])],
    ...(leftAloneGroup === undefined ? {} : { leftAloneGroup }),
    leftAlonePids: [...new Set([...outsideAfter, ...second.unreadable, ...killPass.unreadable])],
    unsignalledPids: [...unsignalled],
  };
  const signalled = termPass.sent.length > 0 || killPass.sent.length > 0;
  if (outsideAfter.length > 0) return listed(unknownResult(findingNotes(findings).join(' '), signalled, findings), lastHolders);
  const summary = signalled ? 'The interrupted command was stopped.' : NONE_VERIFIED;
  return listed(unknownResult([summary, ...findingNotes(findings)].join(' '), signalled, findings), lastHolders);
};

export type ReapMarkedProcessesOptions = {
  marker: string;
  pgid?: number | undefined;
  killGraceMs: number;
  label: string;
  onWarning(message: string): void;
  kill?: SignalSender;
  groupPort?: ProcessGroupPort;
  timing?: Timing;
  signal?: AbortSignal | undefined;
  inspector: ProcessInspector;
  uninspectable?: UninspectableRegistry;
  markerMode?: MarkerMode;
};

const MARKER_CONTENT = /^\d+\n?$/;

export const MARKER_READ_MAX_BYTES = 64;

const readRecordedGroup = async (marker: string): Promise<number | undefined> => {
  const handle = await nodeFileSystem.openRead(marker, OPEN_FLAGS.readOnly | OPEN_FLAGS.noFollow);
  let content: string;
  try {
    const buffer = Buffer.alloc(MARKER_READ_MAX_BYTES + 1);
    const bytesRead = await handle.read(buffer);
    content = bytesRead > MARKER_READ_MAX_BYTES ? '' : buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
  return MARKER_CONTENT.test(content) ? Number(content.trim()) : parseRecordedGroup(content);
};

const lstatIfPresent = async (target: string): Promise<Stats | undefined> => {
  try {
    return await nodeFileSystem.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

export type ReapReport = { removed: boolean; stopped: boolean; uninspectable: UninspectableProcess[] };

type HolderPass = { unsignalled: Set<number>; leftAlone: number[]; signalled: boolean };

const signalHoldersOnly = async (
  marker: string,
  killGraceMs: number,
  send: AsyncSignalSender,
  timing: Timing,
  stop: AbortSignal,
  inspector: ProcessInspector,
  unsettled: Map<number, UninspectableProcess>,
): Promise<HolderPass> => {
  const listing: Listing = { inspector, timing, signal: stop };
  const deadline = timing.monotonicMs() + killGraceMs;
  const holders = (await holdersUntil(marker, listing, deadline, unsettled)).filter((pid) => pid > 1);
  if (stop.aborted) return { unsignalled: new Set(), leftAlone: [], signalled: false };
  const reads = sweepReads(inspector, stop);
  const listed = await identify(holders, reads);
  const proved: ProvedSignal = { send, reads, stop };
  const termPass = await signalProved(proved, listed.identities.map(ownProof), 'SIGTERM');
  const unsignalled = new Set(termPass.unsignalled);
  const remaining = await holdersUntilNone(marker, listing, deadline, unsettled, () => false);
  if (stop.aborted) return { unsignalled, leftAlone: [...new Set([...listed.unreadable, ...termPass.unreadable])], signalled: termPass.sent.length > 0 };
  const leftAlone = new Set<number>();
  const kept = await identify(remaining.filter((pid) => pid > 1), reads);
  const killPass = await signalProved(proved, kept.identities.map(ownProof), 'SIGKILL');
  for (const pid of killPass.unsignalled) unsignalled.add(pid);
  for (const pid of [...kept.unreadable, ...killPass.unreadable]) leftAlone.add(pid);
  return { unsignalled, leftAlone: [...leftAlone], signalled: termPass.sent.length > 0 || killPass.sent.length > 0 };
};

export type ReapHoldersOptions = {
  marker: string;
  killGraceMs: number;
  kill?: SignalSender;
  timing?: Timing;
  signal?: AbortSignal | undefined;
  inspector: ProcessInspector;
};

export const reapHolders = async ({ marker, killGraceMs, kill, timing = systemWaitTiming, signal, inspector }: ReapHoldersOptions): Promise<{ signalled: boolean; unsignalled: number[]; uninspectable: UninspectableProcess[] }> => {
  const operation = operationSignal(signal);
  try {
    const unsettled = new Map<number, UninspectableProcess>();
    const pass = await signalHoldersOnly(marker, killGraceMs, asyncSenderOf(kill), timing, operation.signal, inspector, unsettled);
    return { signalled: pass.signalled, unsignalled: [...pass.unsignalled], uninspectable: [...unsettled.values()] };
  } finally {
    operation.end();
  }
};

const joinPids = (pids: readonly number[]): string => pids.join(', ');

const leftAloneWarning = (label: string, marker: string, pids: readonly number[]): string =>
  `${label} marker ${marker}: process ${joinPids(pids)} is still alive but could not be verified as belonging to this call, so it was left alone`;

const reapWithin = async (options: ReapMarkedProcessesOptions, stop: AbortSignal): Promise<ReapReport> => {
  const { marker, pgid, killGraceMs, label, onWarning, kill, timing = systemWaitTiming, inspector, markerMode = 'listed' } = options;
  const send = asyncSenderOf(kill);
  const ended = (stopped: boolean, uninspectable: UninspectableProcess[]): ReapReport => ({ removed: false, stopped, uninspectable });
  if (stop.aborted) return ended(false, []);
  const stat = await lstatIfPresent(marker);
  if (stat === undefined) return { removed: true, stopped: false, uninspectable: [] };
  if (!stat.isFile()) {
    await nodeFileSystem.rm(marker);
    onWarning(`${label} marker ${marker} was not a regular file, so it was removed without being followed`);
    return { removed: true, stopped: false, uninspectable: [] };
  }
  const recorded = pgid ?? (await readRecordedGroup(marker));
  const group = groupPortOf(options.groupPort, kill);
  if (recorded !== undefined && (await recallMarkerGroup(group, marker, recorded)) === 'unknown') {
    onWarning(`${label} marker ${marker} kept: it records no name for group ${recorded}, and this process did not start that group, so its processes cannot be proved`);
    return ended(false, []);
  }
  const ownGroup = (await holderGroups([process.pid], recorded === undefined ? [] : [recorded], { signal: stop, inspector }))[0];
  const unsettled = new Map<number, UninspectableProcess>();
  let stopped: boolean;
  let remaining: number[];
  if (recorded !== undefined && recorded > 1 && recorded !== ownGroup) {
    const end = await reconcileWithin({ pgid: recorded, marker }, { killGraceMs, kill, group, timing, stop, inspector, unsettled, markerMode });
    if (end.kind === 'unlisted') throw new ReapUnlisted(end.failure, end.signalled);
    const { result } = end;
    stopped = result.stopped;
    if (result.leftAloneGroup !== undefined) {
      onWarning(`${label} marker ${marker}: group ${result.leftAloneGroup} is still alive but could not be verified as belonging to this call, so it was left alone`);
    }
    if (result.leftAlonePids.length > 0) onWarning(leftAloneWarning(label, marker, result.leftAlonePids));
    if (result.unsignalledPids.length > 0) {
      onWarning(`${label} marker ${marker}: could not signal process ${joinPids(result.unsignalledPids)}`);
    }
    if (stop.aborted) return ended(stopped, [...unsettled.values()]);
    remaining = end.lastHolders;
  } else {
    const { unsignalled, leftAlone, signalled } = await signalHoldersOnly(marker, killGraceMs, send, timing, stop, inspector, unsettled);
    stopped = signalled;
    if (leftAlone.length > 0) onWarning(leftAloneWarning(label, marker, leftAlone));
    if (unsignalled.size > 0) {
      onWarning(`${label} marker ${marker}: could not signal process ${joinPids([...unsignalled])}`);
    }
    if (stop.aborted) return ended(stopped, [...unsettled.values()]);
    remaining = await holdersAfterWindow(marker, { inspector, timing, signal: stop }, KILL_CONFIRM_MS, unsettled);
  }
  if (remaining.length > 0) {
    onWarning(`${label} marker ${marker} kept: process ${joinPids(remaining)} still hold it after cleanup; the next start will retry`);
    return ended(stopped, [...unsettled.values()]);
  }
  if (unsettled.size > 0) return ended(stopped, [...unsettled.values()]);
  const state = await inspector.markerState(marker, { signal: stop, mode: markerMode });
  if (state !== 'free') {
    if (!stop.aborted) onWarning(`${label} marker ${marker} kept: no process holds it, but its state reads ${state} rather than free`);
    return ended(stopped, []);
  }
  await nodeFileSystem.rm(marker);
  return { removed: true, stopped, uninspectable: [] };
};

class ReapUnlisted extends Error {
  readonly failure: Error;
  readonly signalled: boolean;

  constructor(failure: Error, signalled: boolean) {
    super(failure.message);
    this.name = 'ReapUnlisted';
    this.failure = failure;
    this.signalled = signalled;
  }
}

const reapObserved = async (options: ReapMarkedProcessesOptions): Promise<ReapReport> => {
  const operation = operationSignal(options.signal);
  try {
    return await reapWithin(options, operation.signal);
  } catch (error) {
    const endedRead = error instanceof ReapUnlisted || error instanceof ProbeFailedError;
    if (endedRead && endedByAsker(operation.signal)) return { removed: false, stopped: error instanceof ReapUnlisted && error.signalled, uninspectable: [] };
    throw error instanceof ReapUnlisted ? error.failure : error;
  } finally {
    operation.end();
  }
};

export { markerReapClockBoundMs };

export const reapMarkedProcessesWithReport = async (options: ReapMarkedProcessesOptions): Promise<ReapReport> => {
  const outcome = await reapObserved(options);
  const context = `${options.label} marker ${options.marker}`;
  const registry = options.uninspectable ?? defaultUninspectableRegistry;
  const unnamed = outcome.uninspectable.filter((process) => registry.firstNaming(context, process));
  if (unnamed.length > 0) options.onWarning(uninspectableWarning(context, unnamed));
  return outcome;
};

export const reapMarkedProcesses = async (options: ReapMarkedProcessesOptions): Promise<{ removed: boolean }> => {
  const { removed } = await reapMarkedProcessesWithReport(options);
  return { removed };
};

export type ReapMarkerDirectoryOptions = {
  dir: string;
  killGraceMs: number;
  label: string;
  onWarning(message: string): void;
  kill?: SignalSender;
  groupPort?: ProcessGroupPort;
  timing?: Timing;
  signal: AbortSignal;
  inspector: ProcessInspector;
  occasion?: RetryKind;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export type UnreapedMarker = { readonly marker: string; readonly code: string | undefined; readonly error: unknown };

export type ReapMarkerDirectoryResult = { reaped: number; kept: number; unreaped: readonly UnreapedMarker[] };

const unreapedNotice = (label: string, { marker, code, error }: UnreapedMarker): string => `${label} marker ${marker} could not be reaped (${code ?? 'no code'}): ${messageOf(error)}; the next start will retry`;

const markerFilesUnder = async (dir: string): Promise<string[]> => {
  let entries: Dirent[];
  try {
    entries = await nodeFileSystem.readdirEntries(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const nested = await Promise.all(entries.map((entry) => (entry.isDirectory() ? markerFilesUnder(path.join(dir, entry.name)) : Promise.resolve([path.join(dir, entry.name)]))));
  return nested.flat();
};

export type MarkerRemedy = { name: string; group: number | undefined; addressed: 'person' | 'model' };

const holderWords = (group: number | undefined): string => (group === undefined ? 'the process that holds it' : `the process group ${group}`);

export const markerRemedyText = ({ name, group, addressed }: MarkerRemedy): string => {
  const lead = addressed === 'model' ? `Ask the person to stop ${holderWords(group)}, or, if it can stay running, to` : `Stop ${holderWords(group)}, or, if it can stay running,`;
  return `${lead} run /markers ignore ${name} in an interactive session.`;
};

export const survivorNoticeText = (label: string, name: string, group: number | undefined): string =>
  `a ${label} process (marker ${name}) may still be running. MomongaCode has used its ${RETRY_KINDS.length} retries and will not try again. ${markerRemedyText({ name, group, addressed: 'person' })}`;

const allRetriesSpent = (record: AttemptRecord): boolean => RETRY_KINDS.every((kind) => record.spent[kind]);

type MarkerReap = (marker: string) => Promise<{ removed: boolean }>;

const readTextIfPresent = async (marker: string): Promise<string | undefined> => {
  try {
    return await readRecordText(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
};

export const malformedRecordNotice = (label: string, marker: string): string =>
  `a ${label} process (marker ${path.basename(marker)}) may still be running. The attempt record of its marker is malformed, so MomongaCode does not try to stop it. ${markerRemedyText({ name: path.basename(marker), group: undefined, addressed: 'person' })}`;

const reapOnOccasion = async (marker: string, occasion: RetryKind, label: string, onWarning: (message: string) => void, signal: AbortSignal, reap: MarkerReap): Promise<{ removed: boolean }> => {
  const text = await readTextIfPresent(marker);
  if (text === undefined) return { removed: true };
  if (isMalformedRecord(text)) {
    onWarning(malformedRecordNotice(label, marker));
    return { removed: false };
  }
  const record = parseAttemptRecord(text);
  if (record.ignored) return { removed: false };
  const tellPerson = async (): Promise<void> => onWarning(survivorNoticeText(label, path.basename(marker), await readMarkerGroup(marker)));
  if (record.spent[occasion]) {
    if (allRetriesSpent(record)) await tellPerson();
    return { removed: false };
  }
  const claim = await claimRetry(marker, occasion, { signal });
  if (claim === 'absent') return { removed: true };
  if (claim !== 'claimed') return { removed: false };
  const reaped = await reap(marker);
  if (!reaped.removed && allRetriesSpent({ ...record, spent: { ...record.spent, [occasion]: true } })) await tellPerson();
  return reaped;
};

export const reapMarkerDirectory = async ({
  dir,
  killGraceMs,
  label,
  onWarning,
  kill,
  groupPort,
  timing,
  signal,
  inspector,
  occasion,
}: ReapMarkerDirectoryOptions): Promise<ReapMarkerDirectoryResult> => {
  const markers = await markerFilesUnder(dir);
  const reap: MarkerReap = (marker) =>
    reapMarkedProcesses({ marker, killGraceMs, label, onWarning, ...(kill === undefined ? {} : { kill }), ...(groupPort === undefined ? {} : { groupPort }), ...(timing === undefined ? {} : { timing }), signal, inspector });
  const outcomes = await Promise.all(
    markers.map(async (marker): Promise<{ marker: string; removed: boolean } | { marker: string; failure: unknown }> => {
      try {
        const { removed } = occasion === undefined ? await reap(marker) : await reapOnOccasion(marker, occasion, label, onWarning, signal, reap);
        return { marker, removed };
      } catch (failure) {
        return { marker, failure };
      }
    }),
  );
  let reaped = 0;
  let kept = 0;
  const unreaped: UnreapedMarker[] = [];
  for (const outcome of outcomes) {
    if ('failure' in outcome) unreaped.push({ marker: outcome.marker, code: (outcome.failure as NodeJS.ErrnoException).code, error: outcome.failure });
    else if (outcome.removed) reaped += 1;
    else kept += 1;
  }
  for (const marker of unreaped) onWarning(unreapedNotice(label, marker));
  return { reaped, kept, unreaped };
};
