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
  external?: { pid?: number; probe: 'pending' | 'healthy' | 'unhealthy' | 'unresponsive' | 'unreachable' };
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
};

export type SupervisorShutdownResponse = { phase: 'draining' };
