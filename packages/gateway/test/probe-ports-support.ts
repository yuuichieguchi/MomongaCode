import { systemTiming } from '@momonga/foundation';
import { PROBE_STEP_FLOOR_MS } from '../src/probe/client.ts';
import type { ProbePorts } from '../src/probe/client.ts';
import { createRequestGate } from '../src/probe/request-gate.ts';

export const hostProbePorts: ProbePorts = { clock: systemTiming, timers: systemTiming, gate: createRequestGate() };

export const probePortsAt = (at: () => Date): ProbePorts => ({ clock: { now: () => at().getTime() }, timers: systemTiming, gate: createRequestGate() });

export const waitRecordingProbePorts = (at: () => Date, waits: number[]): ProbePorts => ({
  clock: { now: () => at().getTime() },
  timers: {
    now: () => systemTiming.now(),
    monotonicMs: () => systemTiming.monotonicMs(),
    setTimeout: (callback, ms) => {
      if (ms >= PROBE_STEP_FLOOR_MS) return systemTiming.setTimeout(callback, ms);
      waits.push(ms);
      return systemTiming.setTimeout(callback, 0);
    },
    clearTimeout: (handle) => systemTiming.clearTimeout(handle),
  },
  gate: createRequestGate(),
});
