import { providerNameOf } from '@momonga/config';
import { AUTH_DOCUMENT_MAX_BYTES, findOutboundError, isLoopbackHost, isRecord } from '@momonga/foundation';
import { SERVER_KINDS } from '@momonga/protocol';
import type { DetectedLocalServer, DetectedManagedServer, DetectedModel, JsonCheck, LocalServerDetection, LocalServerToolSupport, ManagedServerDescription, ServerKind, ServerKinds } from '@momonga/protocol';
import { readTextLimited } from './adapters/shared/body-reading.ts';
import { runPreconditions } from './managed/preconditions.ts';
import type { ExecFn } from './managed/preconditions.ts';
import { reportedContextCeiling, reportedContextWindow } from './probe/run-probe.ts';

export const DETECTION_BODY_MAX_BYTES = AUTH_DOCUMENT_MAX_BYTES;

export type DetectFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; signal: AbortSignal; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; body: AsyncIterable<Uint8Array> | null }>;

export type DetectLocalServersOptions = {
  candidates: readonly string[];
  typed: readonly string[];
  signal: AbortSignal;
  fetch: DetectFetch;
  servers: readonly ManagedServerDescription[];
  exec: ExecFn;
  exists(path: string): Promise<boolean>;
  kinds?: ServerKinds;
};

export type DescribeModelOptions = { server: DetectedLocalServer; model: DetectedModel; signal: AbortSignal; fetch: DetectFetch; kinds?: ServerKinds };

type Ask = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<unknown>;

class CandidateSilent extends Error {}

const NO_ANSWER = undefined;

const rootOf = (address: string, suffix: string): string => {
  const trimmed = address.replace(/\/+$/, '');
  return suffix !== '' && trimmed.endsWith(suffix) ? trimmed.slice(0, -suffix.length) : trimmed;
};

const candidateRootOf = (address: string, kinds: ServerKinds): string =>
  [...new Set(kinds.map((kind) => kind.baseUrlSuffix))].filter((suffix) => suffix !== '').reduce((root, suffix) => rootOf(root, suffix), address.replace(/\/+$/, ''));

const nothingAnswered = (error: TypeError): boolean => {
  const outbound = findOutboundError(error);
  return outbound === undefined || outbound.failure.kind === 'origin-connection';
};

const answerOf = async (response: { ok: boolean; body: AsyncIterable<Uint8Array> | null }): Promise<unknown> => {
  if (response.body === null) return NO_ANSWER;
  const read = await readTextLimited(response.body, DETECTION_BODY_MAX_BYTES);
  if (!response.ok || read.truncated) return NO_ANSWER;
  try {
    return JSON.parse(read.text) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return NO_ANSWER;
    throw error;
  }
};

const askerOf = (root: string, fetchFn: DetectFetch, signal: AbortSignal): Ask => {
  const asked = new Map<string, Promise<unknown>>();
  const ask = async (method: 'GET' | 'POST', path: string, body: unknown): Promise<unknown> => {
    try {
      const response = await fetchFn(`${root}${path}`, {
        method,
        signal,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      return await answerOf(response);
    } catch (error) {
      if (signal.aborted || (error instanceof TypeError && nothingAnswered(error))) throw new CandidateSilent(`${root}${path} did not answer`, { cause: error });
      throw error;
    }
  };
  return (method, path, body) => {
    if (method !== 'GET') return ask(method, path, body);
    const known = asked.get(path);
    if (known !== undefined) return known;
    const started = ask(method, path, body);
    asked.set(path, started);
    return started;
  };
};

const valueAt = (source: unknown, path: readonly string[]): unknown => path.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), source);

const holds = (answer: unknown, check: JsonCheck): boolean => {
  const value = valueAt(answer, check.path);
  if ('eachHas' in check) return Array.isArray(value) && value.length > 0 && value.every((entry: unknown) => isRecord(entry) && check.eachHas.every((key) => Object.hasOwn(entry, key)));
  if (check.is === 'array') return Array.isArray(value);
  if (check.is === 'object') return isRecord(value);
  return typeof value === check.is;
};

const recognised = async (kind: ServerKind, ask: Ask): Promise<boolean> => {
  for (const request of kind.recognise?.requests ?? []) {
    const answer = await ask(request.method, request.path);
    if (answer === NO_ANSWER || !request.expect.every((check) => holds(answer, check))) return false;
  }
  return true;
};

const countOf = (value: unknown): number | undefined => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined);

const listedModelsOf = async (read: NonNullable<ServerKind['read']>, ask: Ask): Promise<DetectedModel[] | undefined> => {
  const answer = await ask('GET', read.list.path);
  const listed = isRecord(answer) ? answer[read.list.array] : undefined;
  if (!Array.isArray(listed)) return undefined;
  const { filter } = read.list;
  return listed.flatMap((entry: unknown): DetectedModel[] => {
    if (!isRecord(entry)) return [];
    const id = entry[read.list.id];
    if (typeof id !== 'string' || id === '') return [];
    if (filter !== undefined && entry[filter.field] !== filter.equals) return [];
    const contextWindow = read.window === undefined ? reportedContextWindow(entry) : countOf(entry[read.window]);
    const ceiling = read.ceiling === undefined ? reportedContextCeiling(entry) : countOf(entry[read.ceiling]);
    return [{ id, tools: read.tools ?? 'unknown', ...(contextWindow === undefined ? {} : { contextWindow }), ...(ceiling === undefined ? {} : { ceiling }) }];
  });
};

const detectedProviderOf = (kind: ServerKind, address: string, kinds: ServerKinds): string => {
  const connection = { adapter: kind.adapter, baseUrl: address };
  return kind.recognise === undefined ? providerNameOf(connection, kinds) : providerNameOf(connection, [{ ...kind, impliedByAdapter: kind.adapter }]);
};

const detectOne = async (candidate: string, fetchFn: DetectFetch, signal: AbortSignal, kinds: ServerKinds): Promise<DetectedLocalServer | undefined> => {
  const root = candidateRootOf(candidate, kinds);
  const ask = askerOf(root, fetchFn, signal);
  try {
    for (const kind of kinds) {
      if (kind.read === undefined || !(await recognised(kind, ask))) continue;
      const models = await listedModelsOf(kind.read, ask);
      if (models === undefined) continue;
      const address = `${root}${kind.baseUrlSuffix}`;
      return { kind: kind.kind, provider: detectedProviderOf(kind, address, kinds), address, models };
    }
    return undefined;
  } catch (error) {
    if (error instanceof CandidateSilent) return undefined;
    throw error;
  }
};

const templatedValueOf = (source: unknown, template: string): unknown => {
  const [rootKey, ...rest] = template.split('.');
  const holder = isRecord(source) && rootKey !== undefined ? source[rootKey] : undefined;
  if (!isRecord(holder)) return undefined;
  const key = rest.join('.').replace(/<([^>]+)>/g, (_match, name: string) => String(holder[name]));
  return holder[key];
};

const toolSupportOf = (details: unknown, field: string): LocalServerToolSupport => {
  const capabilities = isRecord(details) ? details[field] : undefined;
  if (!Array.isArray(capabilities)) return 'unknown';
  return capabilities.includes('tools') ? 'yes' : 'no';
};

export const describeModel = async (options: DescribeModelOptions): Promise<DetectedModel> => {
  const { server, model } = options;
  const kind = (options.kinds ?? SERVER_KINDS).find((candidate) => candidate.kind === server.kind);
  const details = kind?.read?.details;
  if (kind === undefined || details === undefined) return model;
  const ask = askerOf(rootOf(server.address, kind.baseUrlSuffix), options.fetch, options.signal);
  let answer: unknown;
  try {
    answer = await ask(details.method, details.path, { model: model.id });
  } catch (error) {
    if (!(error instanceof CandidateSilent)) throw error;
    return model;
  }
  if (answer === NO_ANSWER) return model;
  const ceiling = countOf(templatedValueOf(answer, details.ceilingTemplate));
  const { ceiling: _listedCeiling, ...listed } = model;
  return { ...listed, tools: toolSupportOf(answer, details.tools), ...(ceiling === undefined ? {} : { ceiling }) };
};

class PreconditionUnrunnable extends Error {}

const unrunnableExec =
  (exec: ExecFn): ExecFn =>
  async (file, args, execOptions) => {
    try {
      return await exec(file, args, execOptions);
    } catch (error) {
      if (execOptions.signal.aborted) throw error;
      throw new PreconditionUnrunnable(`the precondition "${args.join(' ')}" could not run: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };

const detectManaged = async (description: ManagedServerDescription, options: DetectLocalServersOptions): Promise<DetectedManagedServer | undefined> => {
  const binary = description.binary.defaultPath;
  if (!(await options.exists(binary))) return undefined;
  const listed: DetectedManagedServer = { shape: 'managed', id: description.id, provider: description.provider, binary };
  try {
    const verdict = await runPreconditions(description, binary, unrunnableExec(options.exec), options.signal);
    if (verdict.kind === 'met') return listed;
    return { ...listed, refused: { message: verdict.message, ...(verdict.remedy === undefined ? {} : { remedy: verdict.remedy }) } };
  } catch (error) {
    if (error instanceof PreconditionUnrunnable) return { ...listed, refused: { message: error.message } };
    throw error;
  }
};

export const detectLocalServers = async (options: DetectLocalServersOptions): Promise<LocalServerDetection[]> => {
  const kinds = options.kinds ?? SERVER_KINDS;
  const loopback = options.candidates.filter((candidate) => isLoopbackHost(new URL(candidate).hostname));
  const addresses = [...new Set([...loopback, ...options.typed])];
  const answered = await Promise.all(addresses.map((address) => detectOne(address, options.fetch, options.signal, kinds)));
  const found = answered.flatMap((server) => (server === undefined || server.models.length === 0 ? [] : [server]));
  const managed: DetectedManagedServer[] = [];
  for (const description of options.servers) {
    const server = await detectManaged(description, options);
    if (server !== undefined) managed.push(server);
  }
  return [...found, ...managed];
};
