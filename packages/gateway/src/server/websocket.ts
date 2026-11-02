import type http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { RawData, WebSocket } from 'ws';
import type { StreamEvent } from '@momonga/protocol';
import { ClientDisconnectedError, GatewayError, invalidRequest } from '../core/errors.ts';
import type { ConnectionResponses } from '../core/input.ts';
import type { ResponsesService } from '../core/responses-service.ts';
import type { Services } from '../core/services.ts';
import type { StoredResponse } from '../core/store.ts';
import type { RequestTracker } from './tracker.ts';

export const RESPONSES_WEBSOCKET_PATH = '/v1/responses';
export const CONNECTION_LIMIT_CODE = 'websocket_connection_limit_reached';

const GOING_AWAY = 1001;
const NORMAL_CLOSURE = 1000;
const FORBIDDEN_FIELDS = ['stream', 'stream_options', 'background'] as const;
const NO_HEADERS = { idempotencyKey: undefined, deadlineMs: undefined, traceparent: undefined, tracestate: undefined } as const;

export type WebSocketTransportOptions = {
  services: Services;
  responses: ResponsesService;
  tracker: RequestTracker;
  connectionLimitMs: number;
  authorize?: (request: http.IncomingMessage) => boolean;
  onError?: (error: unknown) => void;
};

export type WebSocketTransport = {
  attach(server: http.Server): void;
  beginClose(): void;
  terminateAll(): void;
};

type ErrorEnvelope = { type: 'error'; status: number; error: { type: string; code: string; message: string; param: string | null } };

const envelopeOf = (error: GatewayError): ErrorEnvelope => ({
  type: 'error',
  status: error.status,
  error: { type: error.body.type, code: error.body.code ?? error.body.type, message: error.body.message, param: error.body.param },
});

const createConnectionResponses = (): ConnectionResponses => {
  let latest: { id: string; response: StoredResponse } | undefined;
  return {
    lookup: (id) => (latest?.id === id ? latest.response : undefined),
    remember: (id, response) => {
      latest = { id, response };
    },
    evict: (id) => {
      if (latest?.id === id) latest = undefined;
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const parseCreateEvent = (text: string): Record<string, unknown> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalidRequest('invalid_json', `the WebSocket message is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw invalidRequest('invalid_body', 'the WebSocket message must be a JSON object');
  const { type, ...body } = parsed;
  if (type !== 'response.create') throw invalidRequest('invalid_event_type', 'the WebSocket message type must be "response.create"', 'type');
  for (const field of FORBIDDEN_FIELDS) {
    if (Object.hasOwn(body, field)) {
      throw invalidRequest('invalid_body', `${field} must not be sent in a WebSocket response.create message`, field);
    }
  }
  return body;
};

const refuse = (socket: Duplex, status: string): void => {
  socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
};

export const createWebSocketTransport = (options: WebSocketTransportOptions): WebSocketTransport => {
  const { services, responses, tracker } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: services.config.limits.maxBodyBytes });
  const connections = new Set<Connection>();

  class Connection {
    private readonly socket: WebSocket;
    private readonly state = createConnectionResponses();
    private readonly queue: string[] = [];
    private readonly lifetime = new AbortController();
    private limitTimer: unknown;
    private draining = false;
    private closing = false;
    private expired = false;

    constructor(socket: WebSocket) {
      this.socket = socket;
      connections.add(this);
      this.limitTimer = services.timers.setTimeout(() => void this.expire(), options.connectionLimitMs);
      socket.on('message', (data) => this.receive(data));
      socket.on('error', (error) => {
        this.lifetime.abort(new ClientDisconnectedError());
        options.onError?.(error);
      });
      socket.once('close', () => {
        services.timers.clearTimeout(this.limitTimer);
        this.lifetime.abort(new ClientDisconnectedError());
        connections.delete(this);
      });
    }

    beginClose(): void {
      if (this.expired) return;
      this.closing = true;
      if (!this.draining) this.socket.close(GOING_AWAY);
    }

    terminate(): void {
      this.socket.terminate();
    }

    private receive(data: RawData): void {
      if (this.closing) return;
      this.queue.push(data.toString());
      if (!this.draining) void this.drain();
    }

    private async expire(): Promise<void> {
      this.closing = true;
      this.expired = true;
      this.queue.length = 0;
      this.lifetime.abort(new ClientDisconnectedError());
      if (this.socket.readyState === this.socket.OPEN) {
        await this.send(envelopeOf(invalidRequest(CONNECTION_LIMIT_CODE, 'the WebSocket connection reached its time limit; open a new connection')));
        this.socket.close(NORMAL_CLOSURE);
      }
    }

    private send(message: unknown): Promise<void> {
      return new Promise((resolve, reject) => {
        this.socket.send(JSON.stringify(message), (error) => (error === undefined || error === null ? resolve() : reject(error)));
      });
    }

    private async drain(): Promise<void> {
      this.draining = true;
      try {
        for (let text = this.queue.shift(); text !== undefined; text = this.queue.shift()) {
          if (this.socket.readyState !== this.socket.OPEN) return;
          await this.turn(text);
        }
      } catch (error) {
        options.onError?.(error);
        this.socket.terminate();
      } finally {
        this.draining = false;
        if (this.closing && !this.expired && this.socket.readyState === this.socket.OPEN) this.socket.close(GOING_AWAY);
      }
    }

    private async turn(text: string): Promise<void> {
      const release = tracker.begin();
      let previousId: string | undefined;
      let failed = false;
      let submission: ReturnType<ResponsesService['submit']> | undefined;
      try {
        const body = parseCreateEvent(text);
        previousId = typeof body['previous_response_id'] === 'string' ? body['previous_response_id'] : undefined;
        submission = responses.submit({ ...body, stream: true }, NO_HEADERS, this.lifetime.signal, this.state);
        for (;;) {
          const step = await submission.events.next();
          if (step.done === true) break;
          await this.send(step.value satisfies StreamEvent);
          if (step.value.type === 'response.failed') failed = true;
        }
      } catch (error) {
        if (error instanceof ClientDisconnectedError) return;
        failed = true;
        if (!(error instanceof GatewayError)) options.onError?.(error);
        const reported =
          error instanceof GatewayError
            ? error
            : new GatewayError({ status: 500, type: 'server_error', code: 'internal_error', message: error instanceof Error ? error.message : String(error) });
        if (this.socket.readyState === this.socket.OPEN) await this.send(envelopeOf(reported));
      } finally {
        if (failed && previousId !== undefined) this.state.evict(previousId);
        await submission?.events.return?.();
        release();
      }
    }
  }

  return {
    attach: (server) => {
      server.on('upgrade', (request, socket, head) => {
        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
        if (pathname !== RESPONSES_WEBSOCKET_PATH) {
          refuse(socket, '404 Not Found');
          return;
        }
        if (options.authorize?.(request) === false) {
          refuse(socket, '401 Unauthorized');
          return;
        }
        if (services.closeSignal.aborted) {
          refuse(socket, '503 Service Unavailable');
          return;
        }
        wss.handleUpgrade(request, socket, head, (client) => void new Connection(client));
      });
    },
    beginClose: () => {
      for (const connection of connections) connection.beginClose();
    },
    terminateAll: () => {
      for (const connection of connections) connection.terminate();
    },
  };
};
