import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { McpInputProtocolError, parseInputRequests } from './input-requests.ts';
import type { ElicitationAnswer, ElicitationRequest } from './input-requests.ts';
import { McpInputSuspension } from './suspension.ts';
import type { McpTimers } from './timers.ts';

export const SERVER_REQUEST_KEY = 'elicitation';

export class McpParkedInputLostError extends Error {
  constructor(parkId: string) {
    super(`the request for input ${parkId} can no longer be answered: the connection that held the server's open call was closed or restarted`);
    this.name = 'McpParkedInputLostError';
  }
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

const deferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

type Flight = {
  id: string;
  abort: AbortController;
  call: Promise<CallToolResult>;
  asked: Deferred<ElicitationRequest>;
  answer: Deferred<ElicitationAnswer> | undefined;
  detach: () => void;
  deadline: unknown;
};

export type ParkedInputs = {
  run(signal: AbortSignal | undefined, timeoutMs: number, start: (signal: AbortSignal, endBudget: () => void) => Promise<CallToolResult>): Promise<CallToolResult>;
  resume(parkId: string, answers: Record<string, ElicitationAnswer>, timeoutMs: number, signal: AbortSignal | undefined): Promise<CallToolResult>;
  release(parkId: string): void;
  serverRequest(params: unknown): Promise<ElicitationAnswer>;
  closeAll(): void;
};

export const createParkedInputs = (epoch: number, timers: McpTimers): ParkedInputs => {
  const active = new Set<Flight>();
  const parked = new Map<string, Flight>();
  let counter = 0;

  const attach = (flight: Flight, signal: AbortSignal | undefined): void => {
    if (signal === undefined) {
      flight.detach = () => undefined;
      return;
    }
    if (signal.aborted) flight.abort.abort(signal.reason);
    const forward = (): void => flight.abort.abort(signal.reason);
    signal.addEventListener('abort', forward, { once: true });
    flight.detach = () => signal.removeEventListener('abort', forward);
  };

  const disarm = (flight: Flight): void => {
    if (flight.deadline !== undefined) timers.clearTimeout(flight.deadline);
    flight.deadline = undefined;
  };

  const arm = (flight: Flight, timeoutMs: number): void => {
    disarm(flight);
    flight.deadline = timers.setTimeout(() => flight.abort.abort(new SdkError(SdkErrorCode.RequestTimeout, 'Request timed out', { timeout: timeoutMs })), timeoutMs);
  };

  const finish = (flight: Flight): void => {
    disarm(flight);
    active.delete(flight);
    parked.delete(flight.id);
    flight.detach();
  };

  const settle = async (flight: Flight): Promise<CallToolResult> => {
    let outcome: { result: CallToolResult } | { request: ElicitationRequest };
    try {
      outcome = await Promise.race([flight.call.then((result) => ({ result })), flight.asked.promise.then((request) => ({ request }))]);
    } catch (error) {
      finish(flight);
      throw error;
    }
    if ('result' in outcome) {
      finish(flight);
      return outcome.result;
    }
    disarm(flight);
    flight.detach();
    active.delete(flight);
    parked.set(flight.id, flight);
    flight.call.catch(() => undefined);
    throw new McpInputSuspension([outcome.request], { kind: 'parked', parkId: flight.id });
  };

  const cancelFlight = (flight: Flight, reason: string): void => {
    flight.answer?.resolve({ action: 'cancel' });
    flight.abort.abort(new Error(reason));
    finish(flight);
  };

  return {
    run: (signal, timeoutMs, start) => {
      counter += 1;
      const abort = new AbortController();
      const flight: Flight = { id: `${epoch}-${counter}`, abort, call: Promise.resolve({ content: [] }), asked: deferred(), answer: undefined, detach: () => undefined, deadline: undefined };
      attach(flight, signal);
      active.add(flight);
      arm(flight, timeoutMs);
      flight.call = start(abort.signal, () => disarm(flight));
      return settle(flight);
    },

    resume: (parkId, answers, timeoutMs, signal) => {
      const flight = parked.get(parkId);
      if (flight === undefined) return Promise.reject(new McpParkedInputLostError(parkId));
      const answer = answers[SERVER_REQUEST_KEY];
      const waiting = flight.answer;
      if (answer === undefined || waiting === undefined) return Promise.reject(new McpInputProtocolError(`no answer was given for the parked request ${parkId}`));
      parked.delete(parkId);
      flight.asked = deferred();
      flight.answer = undefined;
      attach(flight, signal);
      active.add(flight);
      arm(flight, timeoutMs);
      waiting.resolve(answer);
      return settle(flight);
    },

    release: (parkId) => {
      const flight = parked.get(parkId);
      if (flight !== undefined) cancelFlight(flight, `the parked request ${parkId} was released`);
    },

    serverRequest: (params) => {
      const flights = [...active];
      const [flight] = flights;
      if (flights.length !== 1 || flight === undefined) {
        return Promise.reject(new McpInputProtocolError(`the server asked for input while ${flights.length} tool calls were in flight, so the request cannot be attributed to one call`));
      }
      if (flight.answer !== undefined) return Promise.reject(new McpInputProtocolError('the server asked for input again before the first request was answered'));
      const [request] = parseInputRequests({ [SERVER_REQUEST_KEY]: { method: 'elicitation/create', params } });
      if (request === undefined) return Promise.reject(new McpInputProtocolError('the server request carried no elicitation'));
      flight.answer = deferred();
      flight.asked.resolve(request);
      return flight.answer.promise;
    },

    closeAll: () => {
      for (const flight of [...active, ...parked.values()]) cancelFlight(flight, 'the MCP connection is closing');
    },
  };
};
