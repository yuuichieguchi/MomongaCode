import type { RunStateOf, SignalSender } from './process-alive.ts';

export type ProcessPort = {
  readonly pid: number;
  uid(): number | undefined;
  kill: SignalSender;
  runState: RunStateOf | null;
};
