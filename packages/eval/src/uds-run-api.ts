import { createUdsClient, decodeSse } from '@momonga/foundation';
import type { UdsClient, UdsResponse } from '@momonga/foundation';
import { RUN_STATUSES, STOP_REASONS } from '@momonga/protocol';
import type { RunStatus, StopReason } from '@momonga/protocol';
import { EvalError } from './runner.ts';
import type { EvalRunApi } from './runner.ts';
import { parsePublicRunEvent } from './transcript.ts';
import type { TranscriptRun } from './transcript.ts';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const expectJson = async (response: UdsResponse, expected: number, description: string): Promise<unknown> => {
  const text = await response.text();
  if (response.status !== expected) throw new EvalError(`${description} answered ${response.status}: ${text}`);
  return JSON.parse(text);
};

const recordField = (body: unknown, field: string, description: string): Record<string, unknown> => {
  const value = isRecord(body) ? body[field] : undefined;
  if (!isRecord(value)) throw new EvalError(`${description} answered a body without ${field}`);
  return value;
};

const stringField = (record: Record<string, unknown>, field: string, description: string): string => {
  const value = record[field];
  if (typeof value !== 'string') throw new EvalError(`${description}: ${field} must be a string`);
  return value;
};

const numberField = (record: Record<string, unknown>, field: string, description: string): number => {
  const value = record[field];
  if (typeof value !== 'number') throw new EvalError(`${description}: ${field} must be a number`);
  return value;
};

const runViewOf = (view: Record<string, unknown>): TranscriptRun => {
  const description = 'run view';
  const status = stringField(view, 'status', description);
  if (!(RUN_STATUSES as readonly string[]).includes(status)) throw new EvalError(`${description}: status ${status} is not a run status`);
  const stopReason = view['stopReason'];
  if (stopReason !== undefined && (typeof stopReason !== 'string' || !(STOP_REASONS as readonly string[]).includes(stopReason))) {
    throw new EvalError(`${description}: stopReason ${String(stopReason)} is not a stop reason`);
  }
  const usage = view['usage'];
  if (!isRecord(usage)) throw new EvalError(`${description}: usage must be an object`);
  return {
    id: stringField(view, 'id', description),
    status: status as RunStatus,
    ...(stopReason === undefined ? {} : { stopReason: stopReason as StopReason }),
    step: numberField(view, 'step', description),
    usage: {
      inputTokens: numberField(usage, 'inputTokens', description),
      outputTokens: numberField(usage, 'outputTokens', description),
      totalTokens: numberField(usage, 'totalTokens', description),
    },
  };
};

export type UdsEvalRunApi = EvalRunApi & { close(): Promise<void> };

export const createUdsEvalRunApi = (socketPath: string): UdsEvalRunApi => {
  const http: UdsClient = createUdsClient(socketPath);

  async function* events(runId: string): AsyncGenerator<ReturnType<typeof parsePublicRunEvent>> {
    const response = await http.request({ method: 'GET', path: `/v1/runs/${runId}/events`, headers: { accept: 'text/event-stream' } });
    if (response.status !== 200) throw new EvalError(`GET /v1/runs/${runId}/events answered ${response.status}: ${await response.text()}`);
    for await (const frame of decodeSse(response.body)) {
      yield parsePublicRunEvent(JSON.parse(frame.data), `event ${frame.id ?? '?'} of run ${runId}`);
    }
  }

  return {
    createSession: async (input) => {
      const response = await http.request({
        method: 'POST',
        path: '/v1/sessions',
        headers: JSON_HEADERS,
        body: JSON.stringify({ cwd: input.cwd, env: input.env, permissionMode: input.permissionMode }),
      });
      const session = recordField(await expectJson(response, 201, 'POST /v1/sessions'), 'session', 'POST /v1/sessions');
      return { id: stringField(session, 'id', 'session view') };
    },
    createRun: async (sessionId, input) => {
      const description = `POST /v1/sessions/${sessionId}/runs`;
      const response = await http.request({ method: 'POST', path: `/v1/sessions/${sessionId}/runs`, headers: JSON_HEADERS, body: JSON.stringify(input) });
      const run = recordField(await expectJson(response, 202, description), 'run', description);
      return { id: stringField(run, 'id', 'run view') };
    },
    events,
    getRun: async (runId) => {
      const description = `GET /v1/runs/${runId}`;
      const response = await http.request({ method: 'GET', path: `/v1/runs/${runId}` });
      return runViewOf(recordField(await expectJson(response, 200, description), 'run', description));
    },
    resolveApproval: async (approvalId, optionId) => {
      const description = `POST /v1/approvals/${approvalId}`;
      const response = await http.request({ method: 'POST', path: `/v1/approvals/${approvalId}`, headers: JSON_HEADERS, body: JSON.stringify({ optionId }) });
      await expectJson(response, 200, description);
    },
    close: () => http.close(),
  };
};
