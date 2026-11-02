import { ProcessLockHeldError } from '@momonga/foundation';

export class RuntimeAlreadyRunningError extends ProcessLockHeldError {
  constructor(message: string, lockPath: string, holderPid: number | undefined) {
    super(message, lockPath, holderPid);
    this.name = 'RuntimeAlreadyRunningError';
  }
}
