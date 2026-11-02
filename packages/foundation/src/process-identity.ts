import type { ProbeFailure, ProbeResult } from './platform/inspector-types.ts';

export type ProcessIdentity = { kind: 'same' } | { kind: 'gone' } | { kind: 'replaced' } | ProbeFailure;

export const judgeProcessIdentity = (recordedStartMs: number | undefined, current: ProbeResult<number>): ProcessIdentity => {
  switch (current.kind) {
    case 'failed':
      return current;
    case 'gone':
      return { kind: 'gone' };
    case 'value':
      return current.value === recordedStartMs ? { kind: 'same' } : { kind: 'replaced' };
  }
};
