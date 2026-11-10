import { findOutboundError, isLoopbackHost, isRecord } from '@momonga/foundation';
import type { DetectedLocalServer, DetectedManagedServer, DetectedModel, LocalServerDetection, LocalServerToolSupport, ManagedServerDescription } from '@momonga/protocol';
import { runPreconditions } from './managed/preconditions.ts';
import type { ExecFn } from './managed/preconditions.ts';
import { trainedContextOf } from './probe/ollama.ts';
import { reportedContextValue } from './probe/run-probe.ts';

export type DetectFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; signal: AbortSignal; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export type DetectLocalServersOptions = {
  candidates: readonly string[];
  typed: readonly string[];
  signal: AbortSignal;
  fetch: DetectFetch;
  servers: readonly ManagedServerDescription[];
  exec: ExecFn;
  exists(path: string): Promise<boolean>;
};

type Ask = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<unknown>;

type ShapeReader = (ask: Ask) => Promise<Pick<DetectedLocalServer, 'models'> | undefined>;

const rootOf = (baseUrl: string): string => baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');

const nothingAnswered = (error: TypeError): boolean => {
  const outbound = findOutboundError(error);
  return outbound === undefined || outbound.failure.kind === 'origin-connection';
};

const askerOf = (baseUrl: string, fetchFn: DetectFetch, signal: AbortSignal): Ask => {
  const root = rootOf(baseUrl);
  return async (method, path, body) => {
    try {
      const response = await fetchFn(`${root}${path}`, {
        method,
        signal,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (!response.ok) return undefined;
      return await response.json();
    } catch (error) {
      if (signal.aborted || error instanceof SyntaxError || (error instanceof TypeError && nothingAnswered(error))) return undefined;
      throw error;
    }
  };
};

const toolSupportOf = (show: unknown): LocalServerToolSupport => {
  const capabilities = isRecord(show) ? show['capabilities'] : undefined;
  if (!Array.isArray(capabilities)) return 'unknown';
  return capabilities.includes('tools') ? 'yes' : 'no';
};

const trainedContextField = (show: unknown, model: string): { trainedContext?: number } => {
  try {
    return { trainedContext: trainedContextOf(show, model) };
  } catch (error) {
    if (error instanceof Error) return {};
    throw error;
  }
};

const ollamaShape: ShapeReader = async (ask) => {
  const version = await ask('GET', '/api/version');
  if (!isRecord(version) || typeof version['version'] !== 'string') return undefined;
  const tags = await ask('GET', '/api/tags');
  const listed = isRecord(tags) ? tags['models'] : undefined;
  if (!Array.isArray(listed)) return undefined;
  const names = listed.flatMap((entry: unknown) => (isRecord(entry) && typeof entry['name'] === 'string' ? [entry['name']] : []));
  const models = await Promise.all(
    names.map(async (id): Promise<DetectedModel> => {
      const show = await ask('POST', '/api/show', { model: id });
      return { id, tools: toolSupportOf(show), ...trainedContextField(show, id) };
    }),
  );
  return { models };
};

const openAiShape: ShapeReader = async (ask) => {
  const listing = await ask('GET', '/v1/models');
  const data = isRecord(listing) ? listing['data'] : undefined;
  if (!Array.isArray(data)) return undefined;
  const models = data.flatMap((entry: unknown): DetectedModel[] => {
    if (!isRecord(entry) || typeof entry['id'] !== 'string') return [];
    const contextWindow = reportedContextValue(entry);
    return [{ id: entry['id'], tools: 'unknown', ...(contextWindow === undefined ? {} : { contextWindow }) }];
  });
  return { models };
};

const SHAPES = [
  ['ollama', ollamaShape],
  ['openai', openAiShape],
] as const;

const detectOne = async (baseUrl: string, fetchFn: DetectFetch, signal: AbortSignal): Promise<DetectedLocalServer | undefined> => {
  const ask = askerOf(baseUrl, fetchFn, signal);
  for (const [shape, read] of SHAPES) {
    const answered = await read(ask);
    if (answered !== undefined) return { baseUrl, shape, models: answered.models };
  }
  return undefined;
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
  const fetchFn = options.fetch;
  const loopback = options.candidates.filter((candidate) => isLoopbackHost(new URL(candidate).hostname));
  const addresses = [...new Set([...loopback, ...options.typed])];
  const found: DetectedLocalServer[] = [];
  for (const address of addresses) {
    if (options.signal.aborted) break;
    const server = await detectOne(address, fetchFn, options.signal);
    if (server !== undefined) found.push(server);
  }
  const managed: DetectedManagedServer[] = [];
  for (const description of options.servers) {
    const server = await detectManaged(description, options);
    if (server !== undefined) managed.push(server);
  }
  return [...found, ...managed];
};
