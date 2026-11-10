import type { ProbeFailure, ProbeResult, StartTime } from './platform/inspector-types.ts';

export type ProcessIdentity = { kind: 'same' } | { kind: 'gone' } | { kind: 'replaced' } | ProbeFailure;

export const judgeProcessIdentity = (recordedStart: StartTime | undefined, current: ProbeResult<StartTime>): ProcessIdentity => {
  switch (current.kind) {
    case 'failed':
      return current;
    case 'gone':
      return { kind: 'gone' };
    case 'value':
      return current.value === recordedStart ? { kind: 'same' } : { kind: 'replaced' };
  }
};
