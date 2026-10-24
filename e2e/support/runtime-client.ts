import { createUdsClient } from '@momonga/foundation';
import type { UdsResponse } from '@momonga/foundation';
import { RUN_STATUSES } from '@momonga/protocol';
import type { RunHealth, RunStatus } from '@momonga/protocol';
import type { E2eHome } from './home.ts';
import { until } from './wait.ts';
import { isRecord } from './is-record.ts';

export const SESSION_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export type SseFrame = { readonly id?: string; readonly event?: string; readonly data?: string };

export type SseParse = { readonly frames: SseFrame[]; readonly rest: string };

export type SessionView = { readonly id: string } & Readonly<Record<string, unknown>>;

export type RunView = {
  readonly id: string;
  readonly sessionId: string;
  readonly status: RunStatus;
  readonly step: number;
  readonly lastSeq: number;
  readonly cancelRequested: boolean;
} & Readonly<Record<string, unknown>>;

export type RunEventData = { readonly type: string; readonly runId: string; readonly seq: number; readonly step: number } & Readonly<Record<string, unknown>>;

export type RunEventFrame = { readonly id: number; readonly event: string | undefined; readonly data: RunEventData };

export type RunEventStream = {
  frames(): readonly RunEventFrame[];
  toEnd(deadlineMs: number): Promise<RunEventFrame[]>;
  until(predicate: (frame: RunEventFrame) => boolean, deadlineMs: number): Promise<RunEventFrame>;
  close(): Promise<void>;
};

export type EventsOptions = { after?: number };

export type RunHistory = 'inherit' | 'fresh';

export type CreateRunOptions = { history?: RunHistory };

export const createRunBody = (input: string, options: CreateRunOptions = {}): { input: string; history?: RunHistory } => ({
  input,
  ...(options.history === undefined ? {} : { history: options.history }),
});

export type RuntimeClient = {
  createSession(): Promise<{ session: SessionView }>;
  createRun(sessionId: string, input: string, options?: CreateRunOptions): Promise<{ run: RunView; location: string }>;
  getRun(id: string): Promise<{ run: RunView }>;
  cancel(id: string): Promise<{ status: 200 | 202; run: RunView }>;
  events(id: string, options?: EventsOptions): RunEventStream;
  health(): Promise<RunHealth>;
  close(): Promise<void>;
};

const FRAME_SEPARATOR = '\n\n';

const fieldOf = (line: string): { name: string; value: string } => {
  const colon = line.indexOf(':');
  if (colon < 0) return { name: line, value: '' };
  const raw = line.slice(colon + 1);
  return { name: line.slice(0, colon), value: raw.startsWith(' ') ? raw.slice(1) : raw };
};

const frameOf = (block: string): SseFrame | undefined => {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const { name, value } = fieldOf(line);
    if (name === 'id') id = value;
    else if (name === 'event') event = value;
    else if (name === 'data') data.push(value);
  }
  if (id === undefined && event === undefined && data.length === 0) return undefined;
  return { ...(id === undefined ? {} : { id }), ...(event === undefined ? {} : { event }), ...(data.length === 0 ? {} : { data: data.join('\n') }) };
};

export const joinSseChunk = (rest: string, chunk: string): string => (rest + chunk).replaceAll('\r\n', '\n');

export const parseSse = (buffer: string): SseParse => {
  const blocks = buffer.split(FRAME_SEPARATOR);
  const rest = blocks.pop() ?? '';
  const frames = blocks.flatMap((block) => {
    const frame = frameOf(block);
    return frame === undefined ? [] : [frame];
  });
  return { frames, rest };
};

const JSON_HEADERS = { 'content-type': 'application/json' } as const;
const RUN_STATUS_NAMES: ReadonlySet<string> = new Set(RUN_STATUSES);
const SANDBOX_KINDS: ReadonlySet<string> = new Set(['seatbelt', 'none']);

export const framesOfType = (frames: readonly RunEventFrame[], type: string): RunEventFrame[] => frames.filter((frame) => frame.data.type === type);

const isSessionView = (value: unknown): value is SessionView => isRecord(value) && typeof value['id'] === 'string';

const isRunView = (value: unknown): value is RunView =>
  isRecord(value) &&
  typeof value['id'] === 'string' &&
  typeof value['sessionId'] === 'string' &&
  typeof value['status'] === 'string' &&
  RUN_STATUS_NAMES.has(value['status']) &&
  typeof value['step'] === 'number' &&
  typeof value['lastSeq'] === 'number' &&
  typeof value['cancelRequested'] === 'boolean';

const isRunHealth = (value: unknown): value is RunHealth =>
  isRecord(value) &&
  value['status'] === 'ok' &&
  typeof value['pid'] === 'number' &&
  (value['state'] === 'running' || value['state'] === 'draining') &&
  typeof value['sandbox'] === 'string' &&
  SANDBOX_KINDS.has(value['sandbox']);

const isRunEventData = (value: unknown): value is RunEventData =>
  isRecord(value) && typeof value['type'] === 'string' && typeof value['runId'] === 'string' && typeof value['seq'] === 'number' && typeof value['step'] === 'number';

const runEventFrameOf = (frame: SseFrame): RunEventFrame => {
  if (frame.id === undefined || frame.data === undefined) throw new Error(`run event frame without id or data: ${JSON.stringify(frame)}`);
  const id = Number(frame.id);
  if (!Number.isInteger(id)) throw new Error(`run event frame with a non-integer id: ${JSON.stringify(frame)}`);
  const data: unknown = JSON.parse(frame.data);
  if (!isRunEventData(data)) throw new Error(`run event frame whose data is not a run event: ${frame.data}`);
  return { id, event: frame.event, data };
};

type StreamOutcome =
  | { kind: 'match'; frame: RunEventFrame }
  | { kind: 'ended' }
  | { kind: 'failed'; error: unknown };

export const createRuntimeClient = (home: E2eHome): RuntimeClient => {
  const http = createUdsClient(home.paths.sockets.runtime);
  const openStreams = new Set<{ abort(): Promise<void> }>();

  const requireJson = async (response: UdsResponse, expected: readonly number[], description: string): Promise<unknown> => {
    const text = await response.text();
    if (!expected.includes(response.status)) throw new Error(`${description} answered ${response.status}: ${text}`);
    return JSON.parse(text);
  };

  const createSession = async (): Promise<{ session: SessionView }> => {
    const body = {
      cwd: home.project,
      env: { HOME: home.home, PATH: SESSION_PATH, TMPDIR: home.sessionTmp },
      permissionMode: 'bypassPermissions',
      bypassAllowed: true,
    };
    const response = await http.request({ method: 'POST', path: '/v1/sessions', headers: JSON_HEADERS, body: JSON.stringify(body) });
    const parsed = await requireJson(response, [201], 'POST /v1/sessions');
    if (!isRecord(parsed) || !isSessionView(parsed['session'])) throw new Error(`POST /v1/sessions answered a body without a session: ${JSON.stringify(parsed)}`);
    return { session: parsed['session'] };
  };

  const runOf = (parsed: unknown, description: string): RunView => {
    if (!isRecord(parsed) || !isRunView(parsed['run'])) throw new Error(`${description} answered a body without a run: ${JSON.stringify(parsed)}`);
    return parsed['run'];
  };

  const createRun = async (sessionId: string, input: string, options: CreateRunOptions = {}): Promise<{ run: RunView; location: string }> => {
    const response = await http.request({
      method: 'POST',
      path: `/v1/sessions/${sessionId}/runs`,
      headers: JSON_HEADERS,
      body: JSON.stringify(createRunBody(input, options)),
    });
    const parsed = await requireJson(response, [202], `POST /v1/sessions/${sessionId}/runs`);
    const location = response.headers['location'];
    if (location === undefined) throw new Error(`POST /v1/sessions/${sessionId}/runs answered without a Location header`);
    return { run: runOf(parsed, 'POST runs'), location };
  };

  const getRun = async (id: string): Promise<{ run: RunView }> => {
    const response = await http.request({ method: 'GET', path: `/v1/runs/${id}` });
    return { run: runOf(await requireJson(response, [200], `GET /v1/runs/${id}`), 'GET run') };
  };

  const cancel = async (id: string): Promise<{ status: 200 | 202; run: RunView }> => {
    const response = await http.request({ method: 'POST', path: `/v1/runs/${id}/cancel` });
    const parsed = await requireJson(response, [200, 202], `POST /v1/runs/${id}/cancel`);
    const status = response.status === 200 ? 200 : 202;
    return { status, run: runOf(parsed, 'POST cancel') };
  };

  const health = async (): Promise<RunHealth> => {
    const response = await http.request({ method: 'GET', path: '/v1/health' });
    const parsed = await requireJson(response, [200], 'GET /v1/health');
    if (!isRunHealth(parsed)) throw new Error(`GET /v1/health answered a body that is not a run health: ${JSON.stringify(parsed)}`);
    return parsed;
  };

  const events = (id: string, options: EventsOptions = {}): RunEventStream => {
    const controller = new AbortController();
    const frames: RunEventFrame[] = [];
    let ended = false;
    let failure: { error: unknown } | undefined;
    let surfaced = false;
    let closing = false;

    const read = async (): Promise<void> => {
      const query = options.after === undefined ? '' : `?after=${options.after}`;
      const response = await http.request({ method: 'GET', path: `/v1/runs/${id}/events${query}`, headers: { accept: 'text/event-stream' }, signal: controller.signal });
      if (response.status !== 200) throw new Error(`GET /v1/runs/${id}/events answered ${response.status}: ${await response.text()}`);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body) {
        buffer = joinSseChunk(buffer, decoder.decode(chunk, { stream: true }));
        const parsed = parseSse(buffer);
        buffer = parsed.rest;
        for (const frame of parsed.frames) frames.push(runEventFrameOf(frame));
      }
    };

    const reader = read().then(
      () => {
        ended = true;
      },
      (error: unknown) => {
        ended = true;
        if (!closing) failure = { error };
      },
    );

    const settle = async (find: () => RunEventFrame | undefined, deadlineMs: number, description: string): Promise<StreamOutcome> =>
      until<StreamOutcome | undefined>(
        () => {
          const frame = find();
          if (frame !== undefined) return { kind: 'match', frame };
          if (failure !== undefined) return { kind: 'failed', error: failure.error };
          if (ended) return { kind: 'ended' };
          return undefined;
        },
        { deadlineMs, description },
      );

    const surface = (outcome: StreamOutcome): void => {
      if (outcome.kind === 'failed') {
        surfaced = true;
        throw outcome.error;
      }
    };

    const abort = async (): Promise<void> => {
      closing = true;
      controller.abort();
      openStreams.delete(handle);
      await reader;
    };

    const handle: RunEventStream & { abort(): Promise<void> } = {
      frames: () => [...frames],
      toEnd: async (deadlineMs) => {
        const outcome = await settle(() => undefined, deadlineMs, `the event stream of run ${id} to end`);
        surface(outcome);
        return [...frames];
      },
      until: async (predicate, deadlineMs) => {
        const outcome = await settle(() => frames.find(predicate), deadlineMs, `a matching event of run ${id}`);
        surface(outcome);
        if (outcome.kind === 'ended') throw new Error(`the event stream of run ${id} ended without a matching frame; ${frames.length} frames seen`);
        if (outcome.kind !== 'match') throw new Error(`unexpected stream outcome ${outcome.kind}`);
        return outcome.frame;
      },
      close: async () => {
        await abort();
        if (failure !== undefined && !surfaced) {
          surfaced = true;
          throw failure.error;
        }
      },
      abort,
    };
    openStreams.add(handle);
    return handle;
  };

  const close = async (): Promise<void> => {
    await Promise.all([...openStreams].map((stream) => stream.abort()));
    await http.close();
  };

  return { createSession, createRun, getRun, cancel, events, health, close };
};
