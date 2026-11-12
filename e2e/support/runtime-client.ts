import { PERSON_CAPABILITY_HEADER } from '@momonga/protocol';
import { nodeFileSystem, personCapabilityOf, systemRandom } from '@momonga/foundation';
import { createUdsClient, fixedSocket } from '@momonga/foundation';
import type { SocketResolver } from '@momonga/foundation';
import { isOpaqueEvent } from '@momonga/protocol';
import type { AnsweredByView, PermissionMode, ReportPage, RunHealth, Mandate } from '@momonga/protocol';
import { RunApiError, createRuntimeClient as createProductClient } from '../../packages/cli/src/client/runtime-client.ts';
import type { RuntimeClient as ProductClient } from '../../packages/cli/src/client/runtime-client.ts';
import { nodeClock } from '../../packages/cli/src/node-ports.ts';
import type { ApprovalView, RunView, SessionView } from '../../packages/cli/src/client/views.ts';
import type { E2eHome } from './home.ts';
import { until } from './wait.ts';
import { firstGeneration, testKernelLock } from '@momonga/testkit';

export type { ApprovalView, RunView, SessionView };

const JSON_HEADERS = { 'content-type': 'application/json' };

export const personCapabilityOfHome = (home: Pick<E2eHome, 'home'>): Promise<string> => personCapabilityOf({ files: nodeFileSystem, random: systemRandom, lock: testKernelLock() }, home.home);

export const SESSION_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export type RunEventData = { readonly type: string; readonly runId: string; readonly seq: number; readonly step: number } & Readonly<Record<string, unknown>>;

export type RunEventFrame = { readonly id: number; readonly event: string | undefined; readonly data: RunEventData };

export type RunEventStream = {
  frames(): readonly RunEventFrame[];
  toEnd(deadlineMs: number): Promise<RunEventFrame[]>;
  until(predicate: (frame: RunEventFrame) => boolean, deadlineMs: number): Promise<RunEventFrame>;
  close(): Promise<void>;
};

export type EventsOptions = { after?: number; lastEventId?: number };

export type CreateSessionOptions = { permissionMode?: PermissionMode };

export type RawResponse = { readonly status: number; readonly body: unknown };

export type CreateRunOptions = { history?: 'inherit' | 'fresh'; mandate?: Mandate };

export type RuntimeClient = {
  createSession(options?: CreateSessionOptions): Promise<{ session: SessionView }>;
  createRun(sessionId: string, input: string, options?: CreateRunOptions): Promise<{ run: RunView; location: string }>;
  getRun(id: string): Promise<{ run: RunView }>;
  cancel(id: string): Promise<{ status: 200 | 202; run: RunView }>;
  events(id: string, options?: EventsOptions): RunEventStream;
  eventsStatus(id: string, options: EventsOptions): Promise<RawResponse>;
  approvals(runId: string): Promise<ApprovalView[]>;
  resolveApproval(id: string, optionId: string): Promise<RawResponse>;
  json(method: string, path: string, body?: unknown): Promise<RawResponse>;
  health(): Promise<RunHealth>;
  reportFacts(request: { cursor: string | null; limit: number }): Promise<ReportPage>;
  answeredBy(runId: string): Promise<AnsweredByView[]>;
  close(): Promise<void>;
};

export const framesOfType = (frames: readonly RunEventFrame[], type: string): RunEventFrame[] => frames.filter((frame) => frame.data.type === type);

type StreamOutcome = { kind: 'match'; frame: RunEventFrame } | { kind: 'ended' } | { kind: 'failed'; error: unknown };

export const createRuntimeClient = (home: E2eHome, resolveSocket: SocketResolver = fixedSocket(firstGeneration(home.paths).sockets.runtime)): RuntimeClient => {
  const product: ProductClient = createProductClient({ resolveSocket, clock: nodeClock, personCapability: () => personCapabilityOfHome(home) });
  const http = createUdsClient(resolveSocket, { connectTimeoutMs: 0 });
  const openStreams = new Set<{ abort(): Promise<void> }>();

  const createSession = async (options: CreateSessionOptions = {}): Promise<{ session: SessionView }> => {
    const { session } = await product.createSession({
      cwd: home.project,
      env: { HOME: home.home, PATH: SESSION_PATH, TMPDIR: home.sessionTmp },
      ...(options.permissionMode === undefined ? {} : { permissionMode: options.permissionMode }),
      ...(options.permissionMode === 'bypassPermissions' ? { bypassAllowed: true } : {}),
    });
    return { session };
  };

  const events = (id: string, options: EventsOptions = {}): RunEventStream => {
    const controller = new AbortController();
    const frames: RunEventFrame[] = [];
    let ended = false;
    let failure: { error: unknown } | undefined;
    let surfaced = false;
    let closing = false;

    const read = async (): Promise<void> => {
      for await (const frame of product.streamEvents(id, { ...options, signal: controller.signal })) {
        if (isOpaqueEvent(frame.data) || !('runId' in frame.data)) throw new Error(`run event frame without a known run event: ${JSON.stringify(frame.data)}`);
        frames.push({ id: frame.id, event: frame.event, data: frame.data });
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

  const eventsStatus = async (id: string, options: EventsOptions): Promise<RawResponse> => {
    const controller = new AbortController();
    const stream = product.streamEvents(id, { ...options, signal: controller.signal });
    try {
      await stream.next();
      return { status: 200, body: undefined };
    } catch (error) {
      if (error instanceof RunApiError) return { status: error.status, body: error.body };
      throw error;
    } finally {
      controller.abort();
      await stream.return(undefined);
    }
  };

  const resolveApproval = async (id: string, optionId: string): Promise<RawResponse> => {
    try {
      return { status: 200, body: await product.resolveApproval(id, optionId) };
    } catch (error) {
      if (error instanceof RunApiError) return { status: error.status, body: error.body };
      throw error;
    }
  };

  const json = async (method: string, path: string, body?: unknown): Promise<RawResponse> => {
    const response = await http.request({
      method,
      path,
      headers: { [PERSON_CAPABILITY_HEADER]: await personCapabilityOfHome(home), ...(body === undefined ? {} : JSON_HEADERS) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
  };

  const close = async (): Promise<void> => {
    await Promise.all([...openStreams].map((stream) => stream.abort()));
    await http.close();
    await product.close();
  };

  return {
    createSession,
    createRun: (sessionId, input, options) => product.createRun(sessionId, input, options),
    getRun: async (id) => ({ run: await product.getRun(id) }),
    cancel: (id) => product.cancel(id),
    events,
    eventsStatus,
    approvals: (runId) => product.approvals(runId),
    resolveApproval,
    json,
    health: () => product.health(),
    reportFacts: (request) => product.reportFacts(request),
    answeredBy: async (runId) => (await product.runAnsweredBy(runId)).answeredBy,
    close,
  };
};
