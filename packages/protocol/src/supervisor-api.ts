export type SupervisorChildState =
  | 'pending'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'backoff'
  | 'held-config'
  | 'held-version'
  | 'waiting-lock'
  | 'external'
  | 'stopped';

export type SupervisorPhase = 'reaping-orphans' | 'running' | 'draining';

export type SupervisorGenerationRole = 'starting' | 'serving' | 'retiring';

export type SupervisorExitReason =
  | 'requested'
  | 'unexpected-clean'
  | 'failure'
  | 'signal'
  | 'lock-held'
  | 'config'
  | 'startup-timeout'
  | 'spawn-failed'
  | 'settings-read-failed'
  | 'protocol-violation'
  | 'retired'
  | 'version-mismatch';

export type SupervisorChildRole = 'gateway' | 'runtime';

export type SupervisorChildHealth = {
  role: SupervisorChildRole;
  state: SupervisorChildState;
  pid?: number;
  startedAt?: string;
  readyAt?: string;
  progressAt?: string;
  restarts: number;
  consecutiveFailures: number;
  nextAttemptAt?: string;
  lastExit?: { code: number | null; signal: string | null; at: string; reason: SupervisorExitReason };
  heldReason?: string;
  external?: { pid?: number; probe: 'pending' | 'healthy' | 'unhealthy' | 'unresponsive' | 'unreachable' };
};

export type RetentionStatusView = {
  days: number;
  lastSweep: { at: string; sessionsDeleted: number; runsPurged: number; blobsCollected: number } | null;
};

const countField = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined);

export const parseRetentionStatus = (value: unknown): RetentionStatusView | undefined => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { days, lastSweep } = value as Readonly<Record<string, unknown>>;
  const period = countField(days);
  if (period === undefined) return undefined;
  if (lastSweep === null) return { days: period, lastSweep: null };
  if (typeof lastSweep !== 'object') return undefined;
  const sweep = lastSweep as Readonly<Record<string, unknown>>;
  const at = sweep['at'];
  const sessionsDeleted = countField(sweep['sessionsDeleted']);
  const runsPurged = countField(sweep['runsPurged']);
  const blobsCollected = countField(sweep['blobsCollected']);
  if (typeof at !== 'string' || sessionsDeleted === undefined || runsPurged === undefined || blobsCollected === undefined) return undefined;
  return { days: period, lastSweep: { at, sessionsDeleted, runsPurged, blobsCollected } };
};

export type SupervisorHealth = {
  status: 'ok';
  version: string;
  pid: number;
  startedAt: string;
  phase: SupervisorPhase;
  env: 'frozen at supervisor start';
  children: SupervisorChildHealth[];
  logs: { droppedLines: number };
  stopBoundMs?: number;
  generation?: number;
  role?: SupervisorGenerationRole;
  steps?: number;
  jobs?: number;
  calls?: number;
  interrupts?: InterruptedWorkItem[];
  countsNotKnown?: SupervisorChildRole[];
  retention: RetentionStatusView | null;
};

export type SupervisorShutdownResponse = { phase: 'draining' };

export type InterruptedWorkItem = { kind: 'run'; id: string } | { kind: 'job'; id: string; command: string };

export const INTERRUPTED_WORK_LISTED = 5;

export const INTERRUPTED_COMMAND_SHOWN_CHARS = 40;

export const interruptedWorkOf = (runs: readonly string[], jobs: readonly { id: string; command: string }[]): InterruptedWorkItem[] =>
  [
    ...runs.map((id): InterruptedWorkItem => ({ kind: 'run', id })),
    ...jobs.map(({ id, command }): InterruptedWorkItem => ({ kind: 'job', id, command: command.slice(0, INTERRUPTED_COMMAND_SHOWN_CHARS) })),
  ].slice(0, INTERRUPTED_WORK_LISTED);

const interruptedItemOf = (value: unknown): InterruptedWorkItem | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const { kind, id, command } = value as Readonly<Record<string, unknown>>;
  if (typeof id !== 'string') return undefined;
  if (kind === 'run') return { kind, id };
  if (kind === 'job' && typeof command === 'string') return { kind, id, command };
  return undefined;
};

export const parseInterruptedWork = (value: unknown): InterruptedWorkItem[] | undefined => {
  if (!Array.isArray(value) || value.length > INTERRUPTED_WORK_LISTED) return undefined;
  const items = value.map(interruptedItemOf);
  return items.every((item) => item !== undefined) ? items : undefined;
};
