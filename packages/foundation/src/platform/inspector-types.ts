import { isTransientErrno, isTransientErrnoCode } from '../transient-errno.ts';
import type { MarkerMode, MarkerState } from '../marker-state.ts';
import type { LockCapabilityProbe } from './lock-capability.ts';

export type ProbeCause = 'transient' | 'deterministic';

export type ProbeEvidence =
  | { kind: 'errno'; code: string; detail: string }
  | { kind: 'timeout'; detail: string }
  | { kind: 'exit'; exitCode: number; detail: string }
  | { kind: 'unparseable'; detail: string }
  | { kind: 'opaque'; detail: string };

export type ProbeFailure = { kind: 'failed'; cause: ProbeCause; evidence: ProbeEvidence };

export type ProbeResult<T> = { kind: 'gone' } | { kind: 'value'; value: T } | ProbeFailure;

export type UninspectableProcess = { pid: number; command: string; startedAt: number };

export type ProbeOptions = { signal: AbortSignal };

export type MarkerStateOptions = ProbeOptions & { mode?: MarkerMode };

export interface ProcessInspector {
  readonly capability?: LockCapabilityProbe;
  startTimeOf(pid: number, options: ProbeOptions): Promise<ProbeResult<number>>;
  holdersOf(marker: string, options: ProbeOptions, onUninspectable?: (process: UninspectableProcess) => void): Promise<ProbeResult<number[]>>;
  groupsOf(pids: readonly number[], candidateGroups: readonly number[], options: ProbeOptions): Promise<ProbeResult<Map<number, number>>>;
  markerState(marker: string, options: MarkerStateOptions): Promise<MarkerState>;
}

export const classifyProbeCause = (evidence: ProbeEvidence): ProbeCause => {
  switch (evidence.kind) {
    case 'errno':
      return isTransientErrnoCode(evidence.code) ? 'transient' : 'deterministic';
    case 'timeout':
      return 'transient';
    case 'exit':
    case 'unparseable':
    case 'opaque':
      return 'deterministic';
  }
};

export const probeFailed = (evidence: ProbeEvidence): ProbeFailure => ({ kind: 'failed', cause: classifyProbeCause(evidence), evidence });

export const isErrno = (error: unknown, ...codes: string[]): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && codes.includes(code);
};

export const evidenceOfError = (error: unknown): ProbeEvidence => {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof Error) {
    const { code, killed } = error as NodeJS.ErrnoException & { killed?: boolean };
    if (killed === true) return { kind: 'timeout', detail };
    if (typeof code === 'string') return { kind: 'errno', code, detail };
  }
  return { kind: 'opaque', detail };
};

export const failureOfError = (error: unknown): ProbeFailure => probeFailed(evidenceOfError(error));

export class ProbeFailedError extends Error {
  readonly probeCause: ProbeCause;
  readonly evidence: ProbeEvidence;

  constructor(operation: string, failure: ProbeFailure) {
    super(`${operation} failed (${failure.cause}): ${failure.evidence.detail}`);
    this.name = 'ProbeFailedError';
    this.probeCause = failure.cause;
    this.evidence = failure.evidence;
  }
}

export const valueOrThrow = <T>(operation: string, result: ProbeResult<T>, whenGone: T): T => {
  if (result.kind === 'failed') throw new ProbeFailedError(operation, result);
  return result.kind === 'gone' ? whenGone : result.value;
};

export const isTransientFailure = (error: unknown): boolean => (error instanceof ProbeFailedError ? error.probeCause === 'transient' : isTransientErrno(error));
