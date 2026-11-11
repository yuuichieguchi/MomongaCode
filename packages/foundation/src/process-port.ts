import type { SignalSender } from './process-alive.ts';

export type ProcessPort = {
  readonly pid: number;
  uid(): number | undefined;
  kill: SignalSender;
};
