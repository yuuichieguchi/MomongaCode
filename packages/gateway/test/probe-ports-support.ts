import { systemTiming } from '@momonga/foundation';
import type { ProbePorts } from '../src/probe/client.ts';

export const hostProbePorts: ProbePorts = { clock: systemTiming, timers: systemTiming };

export const probePortsAt = (at: () => Date): ProbePorts => ({ clock: { now: () => at().getTime() }, timers: systemTiming });

export const waitRecordingProbePorts = (at: () => Date, stepBoundMs: number, waits: number[]): ProbePorts => ({
  clock: { now: () => at().getTime() },
  timers: {
    setTimeout: (callback, ms) => {
      if (ms === stepBoundMs) return systemTiming.setTimeout(callback, ms);
      waits.push(ms);
      return systemTiming.setTimeout(callback, 0);
    },
    clearTimeout: (handle) => systemTiming.clearTimeout(handle),
  },
});
