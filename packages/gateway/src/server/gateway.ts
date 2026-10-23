import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { listenUnix } from '@momonga/foundation';
import { createCompactionCodec } from '../core/compaction.ts';
import { GatewayError, gatewayClosedError } from '../core/errors.ts';
import { createResponsesService } from '../core/responses-service.ts';
import { createRouter } from '../core/router.ts';
import type { Services } from '../core/services.ts';
import { openGatewayStore } from '../core/store.ts';
import { createUnaryService } from '../core/unary.ts';
import { createRequestValidator, createStoredDataChecks } from '../core/validation.ts';
import type { Gateway, GatewayOptions } from '../types.ts';
import { createApp } from './app.ts';
import { checkGatewayOptions, isLoopbackAddress } from './config-check.ts';
import { createRequestTracker } from './tracker.ts';

type FetchHandler = Parameters<typeof getRequestListener>[0];

const digestOf = (value: string): Buffer => createHash('sha256').update(value).digest();

const bearerTokenOf = (header: string | null): string => {
  if (header === null) return '';
  const match = /^Bearer (.+)$/i.exec(header);
  return match?.[1] ?? '';
};

const unauthorized = (): Response => {
  const error = new GatewayError({ status: 401, type: 'invalid_request', code: 'unauthorized', message: 'a valid bearer token is required' });
  return new Response(JSON.stringify({ error: error.body }), { status: 401, headers: { 'content-type': 'application/json' } });
};

const requireToken =
  (token: string, inner: FetchHandler): FetchHandler =>
  (request, env) => {
    const presented = digestOf(bearerTokenOf(request.headers.get('authorization')));
    return timingSafeEqual(presented, digestOf(token)) ? inner(request, env) : unauthorized();
  };

const listenTcp = (server: http.Server, host: string, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port }, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });

const assertLoopbackBinding = (server: http.Server): void => {
  const address = server.address();
  if (address === null || typeof address === 'string' || !isLoopbackAddress(address.address)) {
    throw new Error(`createGateway: the debug listener bound to ${JSON.stringify(address)}, which is not a loopback address`);
  }
};

const closeServer = (server: http.Server): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

const closeAdapters = async (adapters: GatewayOptions['adapters']): Promise<unknown[]> => {
  const failures: unknown[] = [];
  await Promise.all(
    [...new Set(Object.values(adapters))].map(async (adapter) => {
      try {
        await adapter.close?.();
      } catch (error) {
        failures.push(error);
      }
    }),
  );
  return failures;
};

export const createGateway = async (options: GatewayOptions): Promise<Gateway> => {
  checkGatewayOptions(options);
  const { clock, timers } = options;
  const validator = createRequestValidator();
  const store = openGatewayStore(options.dbPath, createStoredDataChecks());
  const servers: http.Server[] = [];
  const closeController = new AbortController();
  const forceCloseController = new AbortController();
  try {
    const services: Services = {
      config: options.config,
      clock,
      timers,
      random: options.random ?? Math.random,
      router: createRouter({ config: options.config, adapters: options.adapters, clock, timers }),
      store,
      codec: createCompactionCodec(options.hmacKey),
      telemetry: options.telemetry,
      closeSignal: closeController.signal,
      forceCloseSignal: forceCloseController.signal,
    };
    const responses = createResponsesService(services, validator);
    const tracker = createRequestTracker();
    const app = createApp({
      services,
      responses,
      unary: createUnaryService(services, validator),
      tracker,
      startedAtSeconds: Math.floor(clock.now() / 1000),
    });
    const handler: FetchHandler = (request, env) => app.fetch(request, env);

    const unixServer = http.createServer(getRequestListener(handler));
    servers.push(unixServer);
    await listenUnix(unixServer, options.socketPath);

    let tcpPort: number | undefined;
    let tcpServer: http.Server | undefined;
    if (options.debugTcp !== undefined) {
      tcpServer = http.createServer(getRequestListener(requireToken(options.debugTcp.token, handler)));
      servers.push(tcpServer);
      tcpPort = await listenTcp(tcpServer, options.debugTcp.host, options.debugTcp.port);
      assertLoopbackBinding(tcpServer);
    }

    let closing: Promise<void> | undefined;
    let abandonedRuns = 0;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        const reason = gatewayClosedError();
        closeController.abort(reason);
        responses.abortAll(reason);
        const closed = servers.map((server) => closeServer(server));
        for (const server of servers) server.closeIdleConnections();
        let graceHandle: unknown;
        const grace = new Promise<'expired'>((resolve) => {
          graceHandle = timers.setTimeout(() => resolve('expired'), options.config.closeGraceMs);
        });
        const drained = Promise.all([responses.settled(), tracker.idle()]).then(() => 'drained' as const);
        const outcome = await Promise.race([drained, grace]);
        timers.clearTimeout(graceHandle);
        if (outcome === 'expired') {
          abandonedRuns = responses.activeCount();
          forceCloseController.abort(reason);
        }
        for (const server of servers) server.closeAllConnections();
        await Promise.all(closed);
        const adapterFailures = await closeAdapters(options.adapters);
        store.close();
        if (adapterFailures.length > 0) throw new AggregateError(adapterFailures, 'one or more adapters failed to close');
      })();
      return closing;
    };

    return {
      socketPath: options.socketPath,
      tcpPort,
      get abandonedRuns() {
        return abandonedRuns;
      },
      close,
    };
  } catch (error) {
    await Promise.all(servers.map((server) => closeServer(server)));
    store.close();
    throw error;
  }
};
