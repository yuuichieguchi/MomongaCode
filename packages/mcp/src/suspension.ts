import type { ElicitationAnswer, ElicitationRequest } from './input-requests.ts';

export type McpCheckpoint =
  | { kind: 'mrtr'; rounds: number; requestState?: string }
  | { kind: 'task'; taskId: string; answered: string[] };

export type McpResume = { checkpoint: McpCheckpoint; answers: Record<string, ElicitationAnswer> };

export class McpInputSuspension extends Error {
  readonly requests: ElicitationRequest[];
  readonly checkpoint: McpCheckpoint;

  constructor(requests: ElicitationRequest[], checkpoint: McpCheckpoint) {
    super(`the server needs input from the user: ${requests.map((request) => request.key).join(', ')}`);
    this.name = 'McpInputSuspension';
    this.requests = requests;
    this.checkpoint = checkpoint;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const parseCheckpoint = (value: unknown): McpCheckpoint => {
  if (!isRecord(value)) throw new TypeError('an MCP checkpoint must be an object');
  if (value['kind'] === 'mrtr') {
    const { rounds, requestState } = value;
    if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < 0) throw new TypeError('an mrtr checkpoint needs a non-negative integer rounds');
    if (requestState !== undefined && typeof requestState !== 'string') throw new TypeError('an mrtr checkpoint requestState must be a string');
    return { kind: 'mrtr', rounds, ...(requestState === undefined ? {} : { requestState }) };
  }
  if (value['kind'] === 'task') {
    const { taskId, answered } = value;
    if (typeof taskId !== 'string' || taskId === '') throw new TypeError('a task checkpoint needs a taskId');
    if (!Array.isArray(answered) || !answered.every((key) => typeof key === 'string')) throw new TypeError('a task checkpoint needs answered keys');
    return { kind: 'task', taskId, answered: answered as string[] };
  }
  throw new TypeError(`unknown MCP checkpoint kind ${JSON.stringify(value['kind'])}`);
};
