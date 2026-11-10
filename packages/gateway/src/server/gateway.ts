import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { listenUnix, startDeadlineSignal } from '@momonga/foundation';
import type { StopValues } from '@momonga/foundation';
import { createCompactionCodec } from '../core/compaction.ts';
import { createReasoningOriginCodec } from '../core/reasoning-origin.ts';
import { GatewayError, gatewayClosedError } from '../core/errors.ts';
import { createResponsesService } from '../core/responses-service.ts';
import { createRedactor } from '../core/redaction.ts';
import { createRouter } from '../core/router.ts';
import type { GatewayEpoch, GatewayEpochs, GatewayServices } from '../core/services.ts';
import { openGatewayStore } from '../core/store.ts';
import { createUnaryService } from '../core/unary.ts';
import { createRequestValidator, createStoredDataChecks } from '../core/validation.ts';
import type { DerivedModelsOptions, FixedModelsOptions, Gateway, GatewayEpochsShared, GatewayOptions } from '../types.ts';
import { createApp } from './app.ts';
import { checkGatewayOptions, isLoopbackAddress, limitsOf } from './config-check.ts';
import { createRequestTracker } from './tracker.ts';
import { createWebSocketTransport } from './websocket.ts';
import type { WebSocketTransport } from './websocket.ts';

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

const tokenMatches = (token: string, authorization: string | null): boolean =>
  timingSafeEqual(digestOf(bearerTokenOf(authorization)), digestOf(token));

const requireToken =
  (token: string, inner: FetchHandler): FetchHandler =>
  (request, env) =>
    tokenMatches(token, request.headers.get('authorization')) ? inner(request, env) : unauthorized();

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

const closeAdapters = (adapters: FixedModelsOptions['adapters']) => async (values: StopValues | undefined): Promise<void> => {
  const failures: unknown[] = [];
  await Promise.all(
    [...new Set(Object.values(adapters))].map(async (adapter) => {
      try {
        await adapter.close?.(values);
      } catch (error) {
        failures.push(error);
      }
    }),
  );
  if (failures.length > 0) throw new AggregateError(failures, 'one or more adapters failed to close');
};

type ClosableEpochs = { epochs: GatewayEpochs; close(values: StopValues | undefined): Promise<void> };

const fixedEpochs = (options: FixedModelsOptions & Pick<GatewayOptions, 'clock' | 'timers'>, shared: GatewayEpochsShared): ClosableEpochs => {
  const epoch: GatewayEpoch = {
    router: createRouter({ config: options.config, adapters: options.adapters, clock: options.clock, timers: options.timers, ...shared }),
    priceTable: options.priceTable,
    telemetry: options.telemetry,
    planTargets: Object.entries(options.config.models.targets).flatMap(([name, target]) => (target.plan === undefined ? [] : [{ name, ...target.plan }])),
  };
  return {
    epochs: { acquire: async () => ({ value: epoch, release: () => undefined }), close: async () => undefined },
    close: closeAdapters(options.adapters),
  };
};

const derivedEpochs = (epochs: DerivedModelsOptions['epochs']): ClosableEpochs => ({ epochs, close: () => epochs.close() });

const watchServerErrors = (server: http.Server, onFatal: (error: Error) => void): void => {
  server.on('error', (error: Error) => onFatal(error));
};

export const createGateway = async (options: GatewayOptions): Promise<Gateway> => {
  checkGatewayOptions(options);
  const limits = limitsOf(options);
  const { clock, timers } = options;
  const validator = createRequestValidator();
  const store = openGatewayStore(options.dbPath, createStoredDataChecks());
  const servers: http.Server[] = [];
  const transports: WebSocketTransport[] = [];
  const closeController = new AbortController();
  const forceCloseController = new AbortController();
  try {
    const shared: GatewayEpochsShared =
      'epochs' in options
        ? { redactor: options.redactor, reasoningOrigin: options.reasoningOrigin }
        : { redactor: createRedactor({ credentials: options.credentials }), reasoningOrigin: createReasoningOriginCodec(options.hmacKey) };
    const { redactor, reasoningOrigin } = shared;
    options.credentialFeed?.((credential) => redactor.add(credential));
    const source = 'epochs' in options ? derivedEpochs(options.epochs) : fixedEpochs(options, shared);
    const services: GatewayServices = {
      config: limits,
      clock,
      timers,
      random: options.random,
      epochs: source.epochs,
      store,
      codec: createCompactionCodec(options.hmacKey),
      reasoningOrigin,
      closeSignal: closeController.signal,
      forceCloseSignal: forceCloseController.signal,
    };
    const responses = createResponsesService(services, validator);
    const unary = createUnaryService(services, validator);
    const tracker = createRequestTracker();
    const startedAtMs = clock.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const app = createApp({
      services,
      responses,
      unary,
      tracker,
      startedAtSeconds: Math.floor(startedAtMs / 1000),
      costReport: options.costReport,
      billedCalls: options.billedCalls,
      startedAt,
      version: options.version,
      onError: options.onError,
      plan: options.plan,
    });
    const handler: FetchHandler = (request, env) => app.fetch(request, env);

    const webSocket = createWebSocketTransport({
      services,
      responses,
      tracker,
      connectionLimitMs: limits.websocketConnectionMs,
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
    transports.push(webSocket);
    const unixServer = http.createServer(getRequestListener(handler));
    webSocket.attach(unixServer);
    servers.push(unixServer);
    await listenUnix(unixServer, options.socketPath, undefined, startDeadlineSignal(options.startSignal));
    if (options.onFatal !== undefined) watchServerErrors(unixServer, options.onFatal);

    let tcpPort: number | undefined;
    let tcpServer: http.Server | undefined;
    if (options.debugTcp !== undefined) {
      const { token } = options.debugTcp;
      const tcpSockets = createWebSocketTransport({
        services,
        responses,
        tracker,
        connectionLimitMs: limits.websocketConnectionMs,
        authorize: (request) => tokenMatches(token, request.headers.authorization ?? null),
        ...(options.onError === undefined ? {} : { onError: options.onError }),
      });
      transports.push(tcpSockets);
      tcpServer = http.createServer(getRequestListener(requireToken(token, handler)));
      tcpSockets.attach(tcpServer);
      servers.push(tcpServer);
      tcpPort = await listenTcp(tcpServer, options.debugTcp.host, options.debugTcp.port);
      assertLoopbackBinding(tcpServer);
      if (options.onFatal !== undefined) watchServerErrors(tcpServer, options.onFatal);
    }

    let closing: Promise<void> | undefined;
    let abandonedRuns = 0;
    let requestAbort: () => void = () => undefined;
    const abortRequested = new Promise<'aborted'>((resolve) => {
      requestAbort = () => resolve('aborted');
    });
    const close = (values?: StopValues): Promise<void> => {
      closing ??= (async () => {
        const reason = gatewayClosedError();
        closeController.abort(reason);
        responses.abortUnkeyed(reason);
        for (const transport of transports) transport.beginClose();
        const closed = servers.map((server) => closeServer(server));
        for (const server of servers) server.closeIdleConnections();
        const graceMs = values === undefined ? limits.closeGraceMs : values.closeGraceMs;
        let graceHandle: unknown;
        const grace =
          graceMs === 0
            ? Promise.resolve('expired' as const)
            : new Promise<'expired'>((resolve) => {
                graceHandle = timers.setTimeout(() => resolve('expired'), graceMs);
              });
        const drained = Promise.all([responses.settled(), unary.settled(), tracker.idle()]).then(() => 'drained' as const);
        const outcome = await Promise.race([drained, grace, abortRequested]);
        if (graceHandle !== undefined) timers.clearTimeout(graceHandle);
        if (outcome !== 'drained') {
          abandonedRuns = responses.activeCount() + unary.activeCount();
          forceCloseController.abort(reason);
          responses.abortAll(reason);
          unary.abortAll(reason);
        }
        for (const transport of transports) transport.terminateAll();
        for (const server of servers) server.closeAllConnections();
        await Promise.all(closed);
        try {
          await source.close(values);
        } finally {
          store.close();
        }
      })();
      return closing;
    };

    return {
      socketPath: options.socketPath,
      startedAt,
      tcpPort,
      get abandonedRuns() {
        return abandonedRuns;
      },
      addCredential: (credential) => redactor.add(credential),
      close,
      abort: (values) => {
        requestAbort();
        return close(values);
      },
    };
  } catch (error) {
    await Promise.all(servers.map((server) => closeServer(server)));
    store.close();
    throw error;
  }
};
