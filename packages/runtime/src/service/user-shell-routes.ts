import { encodeSse } from '@momonga/foundation';
import { USER_SHELL_RUN_ACTIVE_CODE } from '@momonga/protocol';
import type { UserShellFrame, UserShellRecord, UserShellRequest } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import type { UserInputPort } from '../ports.ts';
import type { Handler, RouteRegistrar } from './app.ts';
import { conflict, notFound } from './errors.ts';
import { STREAM_HEADERS } from './event-stream.ts';
import { JSON_MEDIA_TYPES, readJson, validateBody } from './request.ts';

export const USER_SHELL_RUNNING_CODE = 'user_shell_running';

export type UserShellRoutesDeps = {
  store: Pick<RuntimeStore, 'getSession' | 'userShell'>;
  userInput: Pick<UserInputPort, 'shell'>;
  userCommands: UserCommandRegistry;
  maxBodyBytes: number;
  closeSignal: AbortSignal;
};

export type UserCommands = {
  inFlight(): number;
  ended(): Promise<void>;
  abortAll(reason: string): Promise<void>;
};

export type UserCommandRegistry = UserCommands & {
  start(sessionId: string): AbortSignal | undefined;
  finish(sessionId: string): void;
  stop(sessionId: string): boolean;
};

type RunningCommand = { stop: AbortController; ended: Promise<void>; finished: () => void };

export const createUserCommands = (): UserCommandRegistry => {
  const running = new Map<string, RunningCommand>();
  const ended = async (): Promise<void> => {
    await Promise.all([...running.values()].map((command) => command.ended));
  };
  return {
    inFlight: () => running.size,
    ended,
    abortAll: (reason) => {
      for (const command of running.values()) command.stop.abort(reason);
      return ended();
    },
    start: (sessionId) => {
      if (running.has(sessionId)) return undefined;
      const stop = new AbortController();
      let finished: () => void = () => undefined;
      const ended = new Promise<void>((resolve) => {
        finished = resolve;
      });
      running.set(sessionId, { stop, ended, finished });
      return stop.signal;
    },
    finish: (sessionId) => {
      running.get(sessionId)?.finished();
      running.delete(sessionId);
    },
    stop: (sessionId) => {
      const command = running.get(sessionId);
      command?.stop.abort();
      return command !== undefined;
    },
  };
};

const encoder = new TextEncoder();

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const registerUserShellRoutes = (route: RouteRegistrar, deps: UserShellRoutesDeps): void => {
  const { store, userInput, userCommands } = deps;

  const requireSession = (id: string) => {
    const session = store.getSession(id);
    if (session === undefined) throw notFound(`session ${id} does not exist`);
    return session;
  };

  const run: Handler = async (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    const body = validateBody<UserShellRequest>('UserShellRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    if (store.userShell.runActive(session.id)) throw conflict(USER_SHELL_RUN_ACTIVE_CODE, 'a run of this session is working; a user command starts when it has ended');
    const stopSignal = userCommands.start(session.id);
    if (stopSignal === undefined) throw conflict(USER_SHELL_RUNNING_CODE, 'a user command of this session is already running');
    const signal = AbortSignal.any([stopSignal, context.req.raw.signal, deps.closeSignal]);
    let open = true;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (frame: UserShellFrame): void => {
          if (open) controller.enqueue(encoder.encode(encodeSse({ event: frame.type, data: JSON.stringify(frame) })));
        };
        const work = async (): Promise<void> => {
          const outcome = await userInput.shell(session, body.command, { signal, onUnprotected: (reason) => send({ type: 'unprotected', reason }), onOutput: (text) => send({ type: 'output', text }) });
          if (outcome.kind === 'refused') {
            send({ type: 'refused', reason: outcome.reason });
            return;
          }
          const record: UserShellRecord = { command: body.command, exitCode: outcome.exitCode, output: outcome.output, include: body.include };
          store.userShell.record(session.id, record);
          send({ type: 'exit', record });
        };
        work()
          .finally(() => userCommands.finish(session.id))
          .then(
            () => {
              if (open) controller.close();
            },
            (error: unknown) => {
              if (open) controller.error(error);
            },
          );
      },
      cancel: () => {
        open = false;
        userCommands.stop(session.id);
      },
    });
    return new Response(stream, { headers: STREAM_HEADERS });
  };

  const stopRunning: Handler = (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    return json({ stopped: userCommands.stop(session.id) });
  };

  const pending: Handler = (context) => {
    const session = requireSession(context.req.param('id') ?? '');
    return json({ pending: store.userShell.pending(session.id) });
  };

  route('/v1/sessions/:id/user-shell', { GET: pending, POST: run, DELETE: stopRunning }, { person: ['POST', 'DELETE'] });
};
