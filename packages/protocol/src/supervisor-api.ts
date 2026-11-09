export const SUPERVISOR_API_VERSION = 1;

export type SupervisorChildState =
  | 'pending'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'backoff'
  | 'held-config'
  | 'waiting-lock'
  | 'external'
  | 'stopped';

export type SupervisorPhase = 'reaping-orphans' | 'running' | 'draining';

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
  | 'protocol-violation';

export type SupervisorChildHealth = {
  role: 'gateway' | 'runtime';
  state: SupervisorChildState;
  pid?: number;
  startedAt?: string;
  readyAt?: string;
  restarts: number;
  consecutiveFailures: number;
  nextAttemptAt?: string;
  lastExit?: { code: number | null; signal: string | null; at: string; reason: SupervisorExitReason };
  heldReason?: string;
  external?: { pid?: number; probe: 'pending' | 'healthy' | 'unhealthy' | 'unreachable' };
};

export type SupervisorHealth = {
  status: 'ok';
  version: string;
  apiVersion: 1;
  pid: number;
  startedAt: string;
  phase: SupervisorPhase;
  env: 'frozen at supervisor start';
  children: SupervisorChildHealth[];
  logs: { droppedLines: number };
  stopBoundMs?: number;
};

export type SupervisorShutdownResponse = { phase: 'draining' };
