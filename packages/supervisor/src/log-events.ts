import type { EventPayload, JsonLogger, LogLevel, LogValue, ReservedLogKey } from '@momonga/foundation';
import type { SupervisorExitReason, SupervisorPhase } from '@momonga/protocol';
import type { HeldSource, SpawnReason } from './child-manager.ts';
import type { ChildRole } from './launcher.ts';
import type { StopMode, StopReason } from './restart-policy.ts';

export type { EventPayload, LogValue, ReservedLogKey };

export type SupervisorLogEvent = {
  readonly level: LogLevel;
  readonly msg: string;
  readonly data: Readonly<Record<string, LogValue>>;
  readonly err?: Error;
};

export type EventBuilder<P extends EventPayload> = (payload: P, err?: Error) => SupervisorLogEvent;

export const defineEvent =
  <P extends EventPayload>(msg: string, level: LogLevel | ((payload: P) => LogLevel)): EventBuilder<P> =>
  (payload, err) => ({
    level: typeof level === 'function' ? level(payload) : level,
    msg,
    data: payload,
    ...(err === undefined ? {} : { err }),
  });

export const writeEvent = (logger: JsonLogger, event: SupervisorLogEvent): void => {
  logger[event.level](event.msg, { data: event.data, ...(event.err === undefined ? {} : { err: event.err }) });
};

type ChildRef = { child: ChildRole; childPid: number | null };
type RawRecord = ChildRef & { raw: string; rawBytes: number; truncated?: true };

export const phaseChange = defineEvent<{ from: SupervisorPhase; to: SupervisorPhase }>('phase.change', 'info');
export const childSpawn = defineEvent<ChildRef & { restarts: number; reason: SpawnReason }>('child.spawn', 'info');
export const childReady = defineEvent<ChildRef & { version: string; socketPath: string; startedAt: string }>('child.ready', 'info');
export const childReadyMismatch = defineEvent<ChildRef & { readyService: string; readyPid: number }>('child.ready.mismatch', 'error');
export const childReadyIgnored = defineEvent<ChildRef>('child.ready.ignored', 'info');
export const childVersionMismatch = defineEvent<ChildRef & { childVersion: string; supervisorVersion: string }>('child.version.mismatch', 'error');
export const childStop = defineEvent<ChildRef & { stop: StopReason; mode: StopMode; superseded?: StopReason }>('child.stop', 'info');
export const childExit = defineEvent<ChildRef & { code: number | null; signal: string | null; reason: SupervisorExitReason; restarts: number }>('child.exit', 'info');
export const childBackoff = defineEvent<{ child: ChildRole; delayMs: number; consecutiveFailures: number }>('child.backoff', 'info');
export const childHeld = defineEvent<{ child: ChildRole; heldReason: string; source: HeldSource }>('child.held', 'warn');
export const childExternal = defineEvent<{ child: ChildRole; holderPid: number | null }>('child.external', 'warn');
export const childUnkillable = defineEvent<ChildRef>('child.unkillable', 'error');
export const childError = defineEvent<{ child: ChildRole; childPid: number | null }>('child.error', 'warn');
export const childOutputDropped = defineEvent<ChildRef & { dropped: number; droppedBytes: number }>('child.output.dropped', 'warn');
export const childStderr = defineEvent<RawRecord>('child.stderr', 'warn');
export const childStdout = defineEvent<RawRecord>('child.stdout', 'info');
export const supervisorBackgroundFailed = defineEvent<{ source: string }>('supervisor.background_failed', 'error');
export const supervisorBackgroundTransient = defineEvent<{ source: string }>('supervisor.background_transient', 'warn');
export const settingsChanged = defineEvent<Record<string, never>>('settings.changed', 'info');
export const settingsInvalid = defineEvent<{ detail: string; action: 'keep-running-children-hold-spawns' }>('settings.invalid', 'warn');
export const settingsReadFailed = defineEvent<{ detail: string }>('settings.read_failed', 'warn');
export const settingsWarning = defineEvent<{ detail: string }>('settings.warning', 'warn');
export const settingsRecordFailed = defineEvent<{ detail: string }>('settings.record_failed', 'warn');
export const orphansWaiting = defineEvent<{ markers: number; holders: number }>('orphans.waiting', 'info');
export const orphansReaping = defineEvent<{ holders: number }>('orphans.reaping', 'warn');
export const orphansReaped = defineEvent<{ reaped: number; kept: number }>('orphans.reaped', (payload) => (payload.kept > 0 ? 'warn' : 'info'));
export const orphansWarning = defineEvent<{ detail: string; marker?: string }>('orphans.warning', 'warn');
export const startAbandoned = defineEvent<{ generation: number; reason: string }>('start.abandoned', 'warn');
export const startSuperseded = defineEvent<{ generation: number; current: number }>('start.superseded', 'info');
export const startUnpromoted = defineEvent<{ generation: number; reason: string }>('start.unpromoted', 'warn');
export const generationPromoted = defineEvent<{ generation: number; version: string; startToPromotedMs: number }>('generation.promoted', 'info');
export const generationRetiring = defineEvent<{ generation: number; current: number | null }>('generation.retiring', 'info');
export const generationEnded = defineEvent<{ generation: number; liveMs: number }>('generation.ended', 'info');
export const generationSuccessor = defineEvent<{ generation: number; successor: number | null; version: string; outcome: string }>('generation.successor', (payload) => (payload.outcome === 'started' || payload.outcome === 'joined' ? 'info' : 'warn'));
export const generationMany = defineEvent<{ live: number }>('generation.many', 'warn');
export const generationReaped = defineEvent<{ removed: readonly string[]; kept: readonly string[]; busy: boolean }>('generation.reaped', (payload) => (payload.kept.length > 0 ? 'warn' : 'info'));
export const shutdownBegin = defineEvent<{ mode: 'close' | 'abort' }>('shutdown.begin', 'info');
export const shutdownStep = defineEvent<{ shutdownStep: number; detail: string }>('shutdown.step', 'info');
export const shutdownStepBound = defineEvent<{ shutdownStep: number; detail: string }>('shutdown.step', 'warn');
export const shutdownRecordFailed = defineEvent<{ detail: string }>('shutdown.record_failed', 'warn');
export const shutdownEnd = defineEvent<{ clean: boolean; killed: string; leaked: string }>('shutdown.end', 'info');

export const SUPERVISOR_EVENTS = {
  'phase.change': phaseChange,
  'child.spawn': childSpawn,
  'child.ready': childReady,
  'child.ready.mismatch': childReadyMismatch,
  'child.ready.ignored': childReadyIgnored,
  'child.version.mismatch': childVersionMismatch,
  'child.stop': childStop,
  'child.exit': childExit,
  'child.backoff': childBackoff,
  'child.held': childHeld,
  'child.external': childExternal,
  'child.unkillable': childUnkillable,
  'child.error': childError,
  'child.output.dropped': childOutputDropped,
  'child.stderr': childStderr,
  'child.stdout': childStdout,
  'supervisor.background_failed': supervisorBackgroundFailed,
  'supervisor.background_transient': supervisorBackgroundTransient,
  'settings.changed': settingsChanged,
  'settings.record_failed': settingsRecordFailed,
  'settings.invalid': settingsInvalid,
  'settings.read_failed': settingsReadFailed,
  'settings.warning': settingsWarning,
  'orphans.waiting': orphansWaiting,
  'orphans.reaping': orphansReaping,
  'orphans.reaped': orphansReaped,
  'orphans.warning': orphansWarning,
  'start.abandoned': startAbandoned,
  'start.superseded': startSuperseded,
  'start.unpromoted': startUnpromoted,
  'generation.promoted': generationPromoted,
  'generation.retiring': generationRetiring,
  'generation.ended': generationEnded,
  'generation.successor': generationSuccessor,
  'generation.many': generationMany,
  'generation.reaped': generationReaped,
  'shutdown.begin': shutdownBegin,
  'shutdown.step': shutdownStep,
  'shutdown.end': shutdownEnd,
} as const;
