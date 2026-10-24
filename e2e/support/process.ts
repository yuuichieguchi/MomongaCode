import { groupAlive as groupAliveOf, isProcessAlive } from '@momonga/foundation';

export const isAlive = (pid: number): boolean => isProcessAlive(pid);

export const groupAlive = (pgid: number): boolean => groupAliveOf(pgid);
