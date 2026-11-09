import { X509Certificate } from 'node:crypto';
import tls from 'node:tls';
import { Agent, Dispatcher, Pool, ProxyAgent, fetch as undiciFetch } from 'undici';
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse, buildConnector } from 'undici';
import { isLoopbackHost } from './loopback.ts';
import type { FileSystem } from './node-file-system.ts';
import { routeOf } from './network-route.ts';
import type { NetworkConfig, NetworkSource, Route } from './network-route.ts';

export type TrustSource =
  | { readonly source: 'bundled' | 'system' | 'NODE_EXTRA_CA_CERTS'; readonly certificates: number }
  | { readonly source: NetworkSource; readonly file: string; readonly certificates: number };

export type TrustFailure = { readonly file: string; readonly source: NetworkSource; readonly reason: string };

export type TrustReport = { readonly sources: readonly TrustSource[]; readonly failures: readonly TrustFailure[] };

export type OutboundNetwork = { readonly config: NetworkConfig; readonly trust: TrustReport };

export type OutboundFailure =
  | { readonly kind: 'proxy-unreachable'; readonly proxy: string; readonly source: NetworkSource; readonly code?: string }
  | { readonly kind: 'proxy-refused'; readonly proxy: string; readonly source: NetworkSource; readonly status: number }
  | { readonly kind: 'proxy-auth'; readonly proxy: string; readonly source: NetworkSource }
  | { readonly kind: 'proxy-tls'; readonly proxy: string; readonly source: NetworkSource; readonly code: string; readonly caSources: readonly string[] }
  | { readonly kind: 'proxy-unsupported'; readonly source: NetworkSource; readonly text: string }
  | { readonly kind: 'origin-certificate'; readonly host: string; readonly code: string; readonly caSources: readonly string[] }
  | { readonly kind: 'ca-file'; readonly file: string; readonly source: NetworkSource; readonly reason: string }
  | { readonly kind: 'origin-connection'; readonly origin: string; readonly code?: string };

export type OutboundHop = 'proxy' | 'origin';

const failureText = (failure: OutboundFailure): string => {
  switch (failure.kind) {
    case 'proxy-unreachable':
      return `the proxy ${failure.proxy} from ${failure.source} could not be reached${failure.code === undefined ? '' : ` (${failure.code})`}`;
    case 'proxy-refused':
      return `the proxy ${failure.proxy} from ${failure.source} refused the tunnel with status ${failure.status}`;
    case 'proxy-auth':
      return `the proxy ${failure.proxy} from ${failure.source} replied 407: the proxy requires credentials; put them in the proxy URL`;
    case 'proxy-tls':
      return `the TLS connection to the proxy ${failure.proxy} from ${failure.source} failed (${failure.code}); trusted CA sources: ${failure.caSources.join(', ')}`;
    case 'proxy-unsupported':
      return failure.text;
    case 'origin-certificate':
      return `the certificate of ${failure.host} did not verify (${failure.code}); trusted CA sources: ${failure.caSources.join(', ')}`;
    case 'origin-connection':
      return `the connection to ${failure.origin} failed before a response${failure.code === undefined ? '' : ` (${failure.code})`}`;
    case 'ca-file':
      return `the CA file ${failure.file} from ${failure.source} was not loaded: ${failure.reason}; https connections to remote hosts are refused until it loads`;
  }
};

const hopOf = (failure: OutboundFailure): OutboundHop => (failure.kind === 'origin-certificate' || failure.kind === 'ca-file' || failure.kind === 'origin-connection' ? 'origin' : 'proxy');

export class OutboundConnectionError extends Error {
  readonly failure: OutboundFailure;
  readonly hop: OutboundHop;

  constructor(failure: OutboundFailure, options?: { cause?: unknown }) {
    super(failureText(failure), options);
    this.name = 'OutboundConnectionError';
    this.failure = failure;
    this.hop = hopOf(failure);
  }
}

const MAX_CAUSE_DEPTH = 8;

export const findOutboundError = (error: unknown, depth = 0): OutboundConnectionError | undefined => {
  if (error instanceof OutboundConnectionError) return error;
  if (depth >= MAX_CAUSE_DEPTH || typeof error !== 'object' || error === null || !('cause' in error)) return undefined;
  return findOutboundError(error.cause, depth + 1);
};

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

const codeOf = (error: unknown): string | undefined => {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
};

type LoadedFile = { readonly certificates: readonly string[] } | { readonly reason: string };

const loadCaFile = async (file: string, files: TrustFiles): Promise<LoadedFile> => {
  let text: string;
  try {
    text = await files.readTextFile(file);
  } catch (error) {
    return { reason: `the file could not be read (${codeOf(error) ?? (error instanceof Error ? error.message : String(error))})` };
  }
  const certificates = text.match(PEM_CERTIFICATE) ?? [];
  if (certificates.length === 0) return { reason: 'the file holds no certificate' };
  try {
    for (const pem of certificates) new X509Certificate(pem);
  } catch (error) {
    return { reason: `the file holds a certificate that cannot be parsed (${error instanceof Error ? error.message : String(error)})` };
  }
  return { certificates };
};

export type TrustFiles = Pick<FileSystem, 'readTextFile'>;

export const installTrust = async (config: NetworkConfig, files: TrustFiles): Promise<TrustReport> => {
  const bundled = tls.getCACertificates('bundled');
  const system = tls.getCACertificates('system');
  const extra = tls.getCACertificates('extra');
  const sources: TrustSource[] = [
    { source: 'bundled', certificates: bundled.length },
    { source: 'system', certificates: system.length },
    { source: 'NODE_EXTRA_CA_CERTS', certificates: extra.length },
  ];
  const failures: TrustFailure[] = [];
  const fromFiles: string[] = [];
  for (const { value: file, source } of config.caFiles) {
    const loaded = await loadCaFile(file, files);
    if ('reason' in loaded) {
      failures.push({ file, source, reason: loaded.reason });
      continue;
    }
    sources.push({ source, file, certificates: loaded.certificates.length });
    fromFiles.push(...loaded.certificates);
  }
  tls.setDefaultCACertificates([...bundled, ...system, ...extra, ...fromFiles]);
  return { sources, failures };
};

const caSourceNames = (trust: TrustReport): string[] => trust.sources.map((entry) => ('file' in entry ? `${entry.source} ${entry.file}` : entry.source));

export const proxyPasswordsOf = (config: NetworkConfig): Array<{ readonly source: NetworkSource; readonly password: string }> =>
  [config.httpProxy, config.httpsProxy].flatMap((proxy) => {
    if (proxy === undefined || !URL.canParse(proxy.value)) return [];
    const password = new URL(proxy.value).password;
    return password === '' ? [] : [{ source: proxy.source, password: decodeURIComponent(password) }];
  });

export type OutboundOptions = {
  readonly connectReplyTimeoutMs: number;
  readonly headersTimeout?: number;
  readonly bodyTimeout?: number;
};

const PROXY_HOP = Symbol('momonga.proxyHop');

class ProxyReplyError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`the proxy replied ${status} to CONNECT`);
    this.name = 'ProxyReplyError';
    this.status = status;
  }
}

const isAbort = (error: unknown): boolean => (error instanceof Error && error.name === 'AbortError') || codeOf(error) === 'UND_ERR_ABORTED';

const markedProxyHop = (error: unknown): unknown => {
  if (typeof error === 'object' && error !== null && !isAbort(error)) Object.defineProperty(error, PROXY_HOP, { value: true });
  return error;
};

const causeChain = (error: unknown): unknown[] => {
  const chain: unknown[] = [];
  let current: unknown = error;
  while (chain.length < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null) {
    chain.push(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  return chain;
};

const PROXY_CODES: ReadonlySet<string> = new Set(['UND_ERR_PRX_CONN', 'UND_ERR_PRX_TLS']);

const CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REJECTED',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

const isTlsCode = (code: string): boolean => CERTIFICATE_CODES.has(code) || code === 'UND_ERR_PRX_TLS' || code.startsWith('ERR_SSL_') || code.startsWith('ERR_TLS_');

const FORWARD_AUTH_TEXT = '(407)';

type ProxyRoute = Extract<Route, { kind: 'proxy' }>;

const proxyFailureOf = (route: ProxyRoute, error: unknown, caSources: readonly string[], forwarded: boolean): OutboundFailure | undefined => {
  const chain = causeChain(error);
  const reply = chain.find((entry): entry is ProxyReplyError => entry instanceof ProxyReplyError);
  const base = { proxy: route.display, source: route.source };
  if (reply !== undefined) return reply.status === 407 ? { kind: 'proxy-auth', ...base } : { kind: 'proxy-refused', ...base, status: reply.status };
  if (forwarded && codeOf(error) === 'UND_ERR_INVALID_ARG' && error instanceof Error && error.message.includes(FORWARD_AUTH_TEXT)) return { kind: 'proxy-auth', ...base };
  const onProxyHop = chain.some((entry) => (typeof entry === 'object' && entry !== null && PROXY_HOP in entry) || PROXY_CODES.has(codeOf(entry) ?? ''));
  if (!onProxyHop) return undefined;
  const code = chain.map(codeOf).find((entry) => entry !== undefined);
  if (code !== undefined && isTlsCode(code)) return { kind: 'proxy-tls', ...base, code, caSources };
  return { kind: 'proxy-unreachable', ...base, ...(code === undefined ? {} : { code }) };
};

const certificateCodeOf = (error: unknown): string | undefined => causeChain(error).map(codeOf).find((code) => code !== undefined && CERTIFICATE_CODES.has(code));

const labelledHandler = (handler: Dispatcher.DispatchHandler, label: (error: Error) => Error): Dispatcher.DispatchHandler => {
  let started = false;
  return {
    onRequestStart: (controller, context) => handler.onRequestStart?.(controller, context),
    onRequestUpgrade: (controller, statusCode, headers, socket) => handler.onRequestUpgrade?.(controller, statusCode, headers, socket),
    onResponseStarted: () => handler.onResponseStarted?.(),
    onResponseStart: (controller, statusCode, headers, statusMessage) => {
      started = true;
      handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
    },
    onResponseData: (controller, chunk) => handler.onResponseData?.(controller, chunk),
    onResponseEnd: (controller, trailers) => handler.onResponseEnd?.(controller, trailers),
    onResponseError: (controller, error) => handler.onResponseError?.(controller, started ? error : label(error)),
    onBodySent: (chunk) => handler.onBodySent?.(chunk),
    onRequestSent: () => handler.onRequestSent?.(),
  };
};

type ConnectFunction = (options: Dispatcher.ConnectOptions) => Promise<Dispatcher.ConnectData>;

const tunnelClient = (origin: URL, options: object, connectReplyTimeoutMs: number): Dispatcher => {
  const pool = new Pool(origin, { ...options, headersTimeout: connectReplyTimeoutMs });
  const poolConnect = pool.connect.bind(pool);
  const connect: ConnectFunction = (connectOptions) => poolConnect(connectOptions);
  const bounded: ConnectFunction = async (connectOptions) => {
    let data: Dispatcher.ConnectData;
    try {
      data = await connect(connectOptions);
    } catch (error) {
      throw markedProxyHop(error);
    }
    if (data.statusCode !== 200) {
      data.socket.destroy();
      throw markedProxyHop(new ProxyReplyError(data.statusCode));
    }
    return data;
  };
  Object.defineProperty(pool, 'connect', { value: bounded });
  return pool;
};

type Connector = buildConnector.connector;

const isConnector = (value: unknown): value is Connector => typeof value === 'function';

const markingConnector =
  (connector: Connector): Connector =>
  (options, callback) =>
    connector(options, (...args) => {
      if (args[0] === null) {
        callback(...args);
        return;
      }
      markedProxyHop(args[0]);
      callback(...args);
    });

const siteTimeouts = (options: OutboundOptions): { headersTimeout?: number; bodyTimeout?: number } => ({
  ...(options.headersTimeout === undefined ? {} : { headersTimeout: options.headersTimeout }),
  ...(options.bodyTimeout === undefined ? {} : { bodyTimeout: options.bodyTimeout }),
});

const TLS_SCHEMES: ReadonlySet<string> = new Set(['https:', 'wss:']);

class OutboundDispatcher extends Dispatcher {
  readonly #network: OutboundNetwork;
  readonly #options: OutboundOptions;
  readonly #direct: Agent;
  readonly #proxies = new Map<string, ProxyAgent>();
  readonly #refusals = new Map<string, Agent>();

  constructor(network: OutboundNetwork, options: OutboundOptions) {
    super();
    this.#network = network;
    this.#options = options;
    this.#direct = new Agent(siteTimeouts(options));
  }

  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const destination = new URL(String(options.origin));
    const caSources = caSourceNames(this.#network.trust);
    const [trustFailure] = this.#network.trust.failures;
    if (trustFailure !== undefined && TLS_SCHEMES.has(destination.protocol) && !isLoopbackHost(destination.hostname)) {
      return this.#refuse(new OutboundConnectionError({ kind: 'ca-file', ...trustFailure }), options, handler);
    }
    const route = routeOf(destination, this.#network.config);
    if (route.kind === 'unsupported') {
      return this.#refuse(new OutboundConnectionError({ kind: 'proxy-unsupported', source: route.source, text: route.message }), options, handler);
    }
    const forwarded = route.kind === 'proxy' && !TLS_SCHEMES.has(destination.protocol);
    const signal: unknown = 'signal' in options ? options.signal : undefined;
    const label = (error: Error): Error => {
      if (error instanceof OutboundConnectionError) return error;
      if (signal instanceof AbortSignal && signal.aborted && error === signal.reason) return error;
      if (isAbort(error) && !causeChain(error).some((entry) => entry instanceof ProxyReplyError)) return error;
      const proxyFailure = route.kind === 'proxy' ? proxyFailureOf(route, error, caSources, forwarded) : undefined;
      if (proxyFailure !== undefined) return new OutboundConnectionError(proxyFailure, { cause: error });
      const certificateCode = certificateCodeOf(error);
      if (certificateCode !== undefined) return new OutboundConnectionError({ kind: 'origin-certificate', host: destination.hostname, code: certificateCode, caSources }, { cause: error });
      const code = causeChain(error).map(codeOf).find((entry) => entry !== undefined);
      return new OutboundConnectionError({ kind: 'origin-connection', origin: destination.origin, ...(code === undefined ? {} : { code }) }, { cause: error });
    };
    const target = route.kind === 'proxy' ? this.#proxyFor(route) : this.#direct;
    return target.dispatch(options, labelledHandler(handler, label));
  }

  #refuse(error: OutboundConnectionError, options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    let refusal = this.#refusals.get(error.message);
    if (refusal === undefined) {
      refusal = new Agent({ connect: (_options, callback) => callback(error, null) });
      this.#refusals.set(error.message, refusal);
    }
    return refusal.dispatch(options, handler);
  }

  #proxyFor(route: ProxyRoute): ProxyAgent {
    const existing = this.#proxies.get(route.url.href);
    if (existing !== undefined) return existing;
    const { connectReplyTimeoutMs } = this.#options;
    const timeouts = siteTimeouts(this.#options);
    const proxyOrigin = route.url.origin;
    const agent = new ProxyAgent({
      uri: route.url.href,
      ...timeouts,
      clientFactory: (origin, clientOptions) => tunnelClient(origin, clientOptions, connectReplyTimeoutMs),
      factory: (origin, poolOptions) => {
        const connect: unknown = 'connect' in poolOptions ? poolOptions.connect : undefined;
        const toProxy = new URL(String(origin)).origin === proxyOrigin && isConnector(connect);
        return new Pool(origin, { ...poolOptions, ...timeouts, ...(toProxy ? { connect: markingConnector(connect) } : {}) });
      },
    });
    this.#proxies.set(route.url.href, agent);
    return agent;
  }

  #all(): Dispatcher[] {
    return [this.#direct, ...this.#proxies.values(), ...this.#refusals.values()];
  }

  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: () => void): Promise<void> | void {
    const closing = Promise.all(this.#all().map((dispatcher) => dispatcher.close())).then(() => undefined);
    if (callback === undefined) return closing;
    void closing.then(callback);
  }

  override destroy(): Promise<void>;
  override destroy(error: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(error: Error | null, callback: () => void): void;
  override destroy(first?: Error | null | (() => void), second?: () => void): Promise<void> | void {
    const error = typeof first === 'function' || first === undefined ? null : first;
    const callback = typeof first === 'function' ? first : second;
    const destroying = Promise.all(this.#all().map((dispatcher) => dispatcher.destroy(error))).then(() => undefined);
    if (callback === undefined) return destroying;
    void destroying.then(callback);
  }
}

export const createOutboundDispatcher = (network: OutboundNetwork, options: OutboundOptions): Dispatcher => {
  if (!Number.isSafeInteger(options.connectReplyTimeoutMs) || options.connectReplyTimeoutMs < 0) {
    throw new RangeError(`the outbound dispatcher needs the operation's CONNECT bound as a whole number of milliseconds, not ${options.connectReplyTimeoutMs}`);
  }
  return new OutboundDispatcher(network, options);
};

export type OutboundFetch = (input: string | URL, init?: UndiciRequestInit) => Promise<UndiciResponse>;

export const outboundFetch =
  (dispatcher: Dispatcher): OutboundFetch =>
  (input, init) =>
    undiciFetch(input, { ...init, dispatcher });
