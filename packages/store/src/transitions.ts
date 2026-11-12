import type { RunStatus } from '@momonga/protocol';
import type { Stored } from './rows.ts';

export const CLAIM_STATUSES = ['RUNNING', 'CANCELLING'] as const;

export const CANCEL_ORIGINS = ['QUEUED', 'WAITING_HUMAN', 'RUNNING', 'WAITING_TOOL'] as const;

type Edges = Record<Stored<RunStatus>, readonly RunStatus[]>;

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
  unknown: [],
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
  unknown: [],
};

export const SWEEP_TRANSITIONS: Edges = {
  ...SERVICE_TRANSITIONS,
  QUEUED: ['STOPPED'],
};

export const DEAD_LETTER_TRANSITIONS: Edges = {
  QUEUED: ['FAILED'],
  RUNNING: ['FAILED'],
  WAITING_TOOL: [],
  WAITING_HUMAN: [],
  CANCELLING: ['CANCELLED'],
  COMPLETED: [],
  STOPPED: [],
  FAILED: [],
  CANCELLED: [],
  unknown: [],
};
