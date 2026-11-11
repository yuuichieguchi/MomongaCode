import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CREDENTIAL_CAPABILITY_HEADER, listenUnix, parseOutsideJson, parseStopValues, startDeadlineSignal } from '@momonga/foundation';
import type { KernelLockMechanism, StopValues } from '@momonga/foundation';
import type { ErrorBody, SupervisorHealth, SupervisorShutdownResponse } from '@momonga/protocol';
import { CONTROL_CLOSE_ALL_AFTER_MS, CONTROL_REQUEST_TIMEOUT_MS, SHUTDOWN_BODY_LIMIT_BYTES } from './constants.ts';
import type { SupervisorTimers } from './constants.ts';

export type ShutdownResponseWriter = {
  writeHead(status: number, headers: Readonly<Record<string, string | number>>): unknown;
  end(body: string): unknown;
};

export type CredentialAnswer = { kind: 'value'; value: string } | { kind: 'refused' } | { kind: 'unset' };

export type ControlHandlerOptions = {
  health(): SupervisorHealth;
  credential(name: string, capability: string | undefined): CredentialAnswer;
  onShutdownRequested(values?: StopValues): void;
  onIgnoredStopValues?(reason: string): void;
};

export type ControlServerOptions = ControlHandlerOptions & {
  startSignal?: AbortSignal;
  socketPath: string;
  timers: SupervisorTimers;
  mechanism: KernelLockMechanism;
  onError(error: Error): void;
};

export type ControlServer = {
  readonly socketPath: string;
  close(): Promise<void>;
};

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

const CREDENTIALS_PATH = '/v1/credentials/';

export const respondShutdown = (response: ShutdownResponseWriter, onShutdownRequested: () => void): void => {
  const body = JSON.stringify({ phase: 'draining' } satisfies SupervisorShutdownResponse);
  response.writeHead(202, { 'content-type': JSON_CONTENT_TYPE, 'content-length': Buffer.byteLength(body), connection: 'close' });
  response.end(body);
  onShutdownRequested();
};

const respondJson = (request: IncomingMessage, response: ServerResponse, status: number, value: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': JSON_CONTENT_TYPE, 'content-length': Buffer.byteLength(body), ...extraHeaders });
  response.end(request.method === 'HEAD' ? undefined : body);
};

const respondError = (
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  error: Pick<ErrorBody, 'message' | 'type' | 'code'>,
  extraHeaders: Readonly<Record<string, string>> = {},
): void => respondJson(request, response, status, { error: { ...error, param: null } }, extraHeaders);

const readLimitedBody = (request: IncomingMessage, limitBytes: number, onComplete: (body: string) => void, onOverLimit: () => void): void => {
  const chunks: Buffer[] = [];
  let received = 0;
  let overLimit = false;
  request.on('data', (chunk: Buffer) => {
    if (overLimit) return;
    received += chunk.length;
    if (received > limitBytes) {
      overLimit = true;
      onOverLimit();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (!overLimit) onComplete(Buffer.concat(chunks).toString('utf8'));
  });
};

type ShutdownBody = { kind: 'values'; values: StopValues | undefined } | { kind: 'invalid'; reason: string };

const parseShutdownBody = (body: string): ShutdownBody => {
  if (body.length === 0) return { kind: 'values', values: undefined };
  let parsed: unknown;
  try {
    parsed = parseOutsideJson(body);
  } catch (error) {
    return { kind: 'invalid', reason: `the request body is not JSON within the allowed depth: ${error instanceof Error ? error.message : String(error)}` };
  }
  const values = parseStopValues(parsed);
  return values.kind === 'values' ? { kind: 'values', values: values.values } : { kind: 'invalid', reason: values.reason };
};

export const createControlRequestHandler = (options: ControlHandlerOptions): ((request: IncomingMessage, response: ServerResponse) => void) => {
  return (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const method = request.method ?? 'GET';
    if (pathname === '/v1/health') {
      if (method === 'GET' || method === 'HEAD') {
        respondJson(request, response, 200, options.health());
        return;
      }
      respondError(request, response, 405, { message: `${method} is not allowed on ${pathname}`, type: 'invalid_request', code: 'method_not_allowed' }, { allow: 'GET, HEAD' });
      return;
    }
    if (pathname.startsWith(CREDENTIALS_PATH)) {
      if (method !== 'GET') {
        respondError(request, response, 405, { message: `${method} is not allowed on ${pathname}`, type: 'invalid_request', code: 'method_not_allowed' }, { allow: 'GET' });
        return;
      }
      const name = decodeURIComponent(pathname.slice(CREDENTIALS_PATH.length));
      const given = request.headers[CREDENTIAL_CAPABILITY_HEADER];
      const answer = options.credential(name, typeof given === 'string' ? given : undefined);
      if (answer.kind === 'value') {
        respondJson(request, response, 200, { name, value: answer.value });
        return;
      }
      if (answer.kind === 'refused') {
        respondError(request, response, 403, { message: 'no credential is handed over on this request', type: 'invalid_request', code: 'credential_refused' });
        return;
      }
      respondError(request, response, 404, { message: `the variable ${name} is unset or empty in the environment the daemon started with`, type: 'not_found', code: 'credential_not_set' });
      return;
    }
    if (pathname === '/v1/shutdown') {
      if (method !== 'POST') {
        respondError(request, response, 405, { message: `${method} is not allowed on ${pathname}`, type: 'invalid_request', code: 'method_not_allowed' }, { allow: 'POST' });
        return;
      }
      readLimitedBody(
        request,
        SHUTDOWN_BODY_LIMIT_BYTES,
        (body) => {
          const parsed = parseShutdownBody(body);
          if (parsed.kind === 'invalid') options.onIgnoredStopValues?.(parsed.reason);
          respondShutdown(response, () => options.onShutdownRequested(parsed.kind === 'values' ? parsed.values : undefined));
        },
        () =>
          respondError(
            request,
            response,
            413,
            { message: `request body exceeds ${SHUTDOWN_BODY_LIMIT_BYTES} bytes`, type: 'invalid_request', code: 'payload_too_large' },
            { connection: 'close' },
          ),
      );
      return;
    }
    respondError(request, response, 404, { message: `no route for ${method} ${pathname}`, type: 'not_found', code: 'not_found' });
  };
};

export const startControlServer = async (options: ControlServerOptions): Promise<ControlServer> => {
  const { timers } = options;
  const server = http.createServer(createControlRequestHandler(options));
  server.requestTimeout = CONTROL_REQUEST_TIMEOUT_MS;
  server.headersTimeout = CONTROL_REQUEST_TIMEOUT_MS;
  await listenUnix(server, options.socketPath, { mechanism: options.mechanism }, startDeadlineSignal(options.startSignal));
  server.on('error', options.onError);
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= new Promise<void>((resolve, reject) => {
      const closeAllTimer = timers.setTimeout(() => server.closeAllConnections(), CONTROL_CLOSE_ALL_AFTER_MS);
      server.close((error) => {
        timers.clearTimeout(closeAllTimer);
        if (error === undefined) resolve();
        else reject(error);
      });
      server.closeIdleConnections();
    });
    return closing;
  };
  return { socketPath: options.socketPath, close };
};
