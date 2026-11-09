import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import type { Duplex } from 'node:stream';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { outboundPlan, proxyHopError, proxyReplyError, systemTiming } from '@momonga/foundation';
import type { OutboundNetwork, OutboundPlan } from '@momonga/foundation';

export type OtlpAgent = { readonly agent: http.Agent; readonly labelled: (error: Error) => Error };

type RoutedPlan = Extract<OutboundPlan, { kind: 'route' }>;

type ProxyConnectOptions = Parameters<HttpsProxyAgent<string>['connect']>[1];

type Labels = WeakMap<object, Error>;

const unfinishedConnection = (timeoutMs: number): Error => new Error(`the connection did not complete within ${timeoutMs} ms`);

const readiness = (socket: Duplex, event: 'connect' | 'secureConnect', signal: AbortSignal, onAbort: () => Error): Promise<void> =>
  new Promise((resolve, reject) => {
    const settle = (): void => {
      socket.off(event, onReady);
      socket.off('error', onError);
      socket.off('close', onClose);
      signal.removeEventListener('abort', onAborted);
    };
    const onReady = (): void => {
      settle();
      resolve();
    };
    const onError = (error: Error): void => {
      settle();
      reject(signal.aborted ? onAbort() : error);
    };
    const onClose = (): void => {
      settle();
      reject(signal.aborted ? onAbort() : new Error('the connection closed before it was ready'));
    };
    const onAborted = (): void => {
      socket.destroy(onAbort());
    };
    socket.once(event, onReady);
    socket.once('error', onError);
    socket.once('close', onClose);
    signal.addEventListener('abort', onAborted, { once: true });
  });

const bounded = async <T>(timeoutMs: number, attempt: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  const controller = new AbortController();
  const timer = systemTiming.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await attempt(controller.signal);
  } finally {
    systemTiming.clearTimeout(timer);
  }
};

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error), { cause: error }));

const recorded = (labels: Labels, plan: RoutedPlan, error: unknown): Error => {
  const raw = asError(error);
  labels.set(raw, plan.label(raw));
  return raw;
};

type ConnectionCallback = (error: Error | null, stream: Duplex) => void;

type CreateSocket = (options: http.ClientRequestArgs) => Duplex | null | undefined;

const callbackAgent = (base: typeof http.Agent, connect: (options: http.ClientRequestArgs, create: CreateSocket) => Promise<Duplex>): http.Agent =>
  new (class extends base {
    override createConnection(options: http.ClientRequestArgs, callback?: ConnectionCallback): Duplex | null | undefined {
      if (callback === undefined) throw new TypeError('the OTLP agent connects asynchronously and needs the callback of node:http');
      void connect(options, (socketOptions) => super.createConnection(socketOptions)).then(
        (socket) => callback(null, socket),
        (error: unknown) => Reflect.apply(callback, undefined, [asError(error)]),
      );
      return undefined;
    }
  })({ keepAlive: true });

const directAgent = (base: typeof http.Agent, ready: 'connect' | 'secureConnect', plan: RoutedPlan, timeoutMs: number, labels: Labels): http.Agent =>
  callbackAgent(base, async (options, create) => {
    try {
      return await bounded(timeoutMs, async (signal) => {
        const socket = create(options);
        if (socket === null || socket === undefined) throw new TypeError('node:http created no socket for the OTLP collector');
        await readiness(socket, ready, signal, () => unfinishedConnection(timeoutMs));
        return socket;
      });
    } catch (error) {
      throw recorded(labels, plan, error);
    }
  });

class RoutedProxyAgent extends HttpsProxyAgent<string> {
  readonly #baseConnect: HttpsProxyAgent<string>['connectOpts'];
  readonly #plan: RoutedPlan;
  readonly #timeoutMs: number;
  readonly #labels: Labels;

  constructor(proxy: string, plan: RoutedPlan, timeoutMs: number, labels: Labels) {
    super(proxy, { keepAlive: true });
    this.#baseConnect = this.connectOpts;
    this.#plan = plan;
    this.#timeoutMs = timeoutMs;
    this.#labels = labels;
  }

  override async connect(req: http.ClientRequest, opts: ProxyConnectOptions): Promise<net.Socket> {
    try {
      return await bounded(this.#timeoutMs, (signal) => this.#tunnel(req, opts, signal));
    } catch (error) {
      throw recorded(this.#labels, this.#plan, error);
    }
  }

  async #tunnel(req: http.ClientRequest, opts: ProxyConnectOptions, signal: AbortSignal): Promise<net.Socket> {
    const proxyTimeout = (): Error => proxyHopError(unfinishedConnection(this.#timeoutMs));
    let status: number | undefined;
    req.once('proxyConnect', (reply: { statusCode: number }) => {
      status = reply.statusCode;
    });
    const proxyHop = new AbortController();
    const abortProxyHop = (): void => proxyHop.abort();
    signal.addEventListener('abort', abortProxyHop, { once: true });
    this.connectOpts = { ...this.#baseConnect, signal: proxyHop.signal };
    let socket: net.Socket;
    try {
      socket = await super.connect(req, opts);
    } catch (error) {
      throw signal.aborted ? proxyTimeout() : proxyHopError(error);
    } finally {
      signal.removeEventListener('abort', abortProxyHop);
    }
    if (status === undefined) throw new TypeError('https-proxy-agent returned a tunnel without a CONNECT reply');
    if (status !== 200) {
      socket.destroy();
      throw proxyReplyError(status);
    }
    if (opts.secureEndpoint) await readiness(socket, 'secureConnect', signal, () => unfinishedConnection(this.#timeoutMs));
    return socket;
  }
}

export const createOtlpAgent = (collector: URL, network: OutboundNetwork, timeoutMs: number): OtlpAgent => {
  const labels: Labels = new WeakMap();
  const labelled = (error: Error): Error => labels.get(error) ?? error;
  const plan = outboundPlan(collector, network, { forwardsPlainHttp: false, signal: undefined });
  const secure = collector.protocol === 'https:';
  const base = secure ? https.Agent : http.Agent;
  if (plan.kind === 'refuse') {
    const { error } = plan;
    return { agent: callbackAgent(base, () => Promise.reject(error)), labelled };
  }
  if (plan.route.kind === 'proxy') return { agent: new RoutedProxyAgent(plan.route.url.href, plan, timeoutMs, labels), labelled };
  return { agent: directAgent(base, secure ? 'secureConnect' : 'connect', plan, timeoutMs, labels), labelled };
};
