import type { RunStatus } from '@momonga/protocol';

export const CLAIM_STATUSES = ['RUNNING', 'CANCELLING'] as const;

export const CANCEL_ORIGINS = ['QUEUED', 'WAITING_HUMAN', 'RUNNING', 'WAITING_TOOL'] as const;

type Edges = Record<RunStatus, readonly RunStatus[]>;

export const WORKER_TRANSITIONS: Edges = {
  QUEUED: [],
  RUNNING: ['WAITING_TOOL', 'WAITING_HUMAN', 'COMPLETED', 'STOPPED', 'FAILED', 'CANCELLING', 'QUEUED'],
  WAITING_TOOL: [],
  WAITING_HUMAN: [],
  CANCELLING: ['CANCELLED'],
  COMPLETED: [],
  STOPPED: [],
  FAILED: [],
  CANCELLED: [],
};

export const SERVICE_TRANSITIONS: Edges = {
  QUEUED: ['CANCELLING'],
  RUNNING: ['CANCELLING'],
  WAITING_TOOL: ['QUEUED', 'CANCELLING'],
  WAITING_HUMAN: ['QUEUED', 'CANCELLING', 'STOPPED'],
  CANCELLING: [],
  COMPLETED: [],
  STOPPED: [],
  FAILED: [],
  CANCELLED: [],
};

export const SWEEP_TRANSITIONS: Edges = {
  ...SERVICE_TRANSITIONS,
  QUEUED: ['STOPPED'],
};

export const DEAD_LETTER_TRANSITIONS: Edges = {
  QUEUED: ['FAILED', 'CANCELLED'],
  RUNNING: ['FAILED', 'CANCELLED'],
  WAITING_TOOL: [],
  WAITING_HUMAN: [],
  CANCELLING: ['CANCELLED'],
  COMPLETED: [],
  STOPPED: [],
  FAILED: [],
  CANCELLED: [],
};
