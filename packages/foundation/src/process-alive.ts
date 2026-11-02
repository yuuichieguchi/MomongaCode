import { hostSignalSender } from './platform/group-port.ts';

export type SignalSender = (pid: number, signal: NodeJS.Signals | 0) => void;

export const isProcessAlive = (pid: number, send: SignalSender = hostSignalSender): boolean => {
  try {
    send(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
};
