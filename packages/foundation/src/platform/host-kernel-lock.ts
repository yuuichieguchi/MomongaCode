import { UnsupportedPlatformError } from './process-inspector.ts';
import { bsdFileLock } from './kernel-lock.ts';
import type { KernelLockMechanism } from './kernel-lock.ts';
import { sqliteFileLock } from './sqlite-lock.ts';

export const createKernelLockMechanism = (platform: NodeJS.Platform): KernelLockMechanism => {
  switch (platform) {
    case 'darwin':
      return bsdFileLock;
    case 'linux':
    case 'win32':
      return sqliteFileLock;
    default:
      throw new UnsupportedPlatformError(platform, 'process locks');
  }
};

export const hostKernelLock = (): KernelLockMechanism => createKernelLockMechanism(process.platform);
