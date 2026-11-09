import type { GroupProbeOptions } from './group-port.ts';

const RUN_STATES_PAST_RUNNING = new Set(['Z', 'X']);
const EXITING_FLAG = 'E';

export const canStillRun = (stat: string): boolean => !RUN_STATES_PAST_RUNNING.has(stat.charAt(0)) && !stat.slice(1).includes(EXITING_FLAG);

export type GroupStatesReader = (pgid: number, options: GroupProbeOptions) => Promise<string[]>;
