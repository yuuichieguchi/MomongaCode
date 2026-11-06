import { findOutboundError, isLoopbackHost, isRecord } from '@momonga/foundation';
import type { DetectedLocalServer, LocalServerToolSupport } from '@momonga/protocol';

export type DetectFetch = (
  url: string,
  init: { method: 'GET' | 'POST'; signal: AbortSignal; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export type DetectLocalServersOptions = {
  candidates: readonly string[];
  typed: readonly string[];
  signal: AbortSignal;
  fetch: DetectFetch;
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

const ollamaShape: ShapeReader = async (ask) => {
  const version = await ask('GET', '/api/version');
  if (!isRecord(version) || typeof version['version'] !== 'string') return undefined;
  const tags = await ask('GET', '/api/tags');
  const listed = isRecord(tags) ? tags['models'] : undefined;
  if (!Array.isArray(listed)) return undefined;
  const names = listed.flatMap((entry: unknown) => (isRecord(entry) && typeof entry['name'] === 'string' ? [entry['name']] : []));
  const models = await Promise.all(names.map(async (id) => ({ id, tools: toolSupportOf(await ask('POST', '/api/show', { model: id })) })));
  return { models };
};

const openAiShape: ShapeReader = async (ask) => {
  const listing = await ask('GET', '/v1/models');
  const data = isRecord(listing) ? listing['data'] : undefined;
  if (!Array.isArray(data)) return undefined;
  const ids = data.flatMap((entry: unknown) => (isRecord(entry) && typeof entry['id'] === 'string' ? [entry['id']] : []));
  return { models: ids.map((id) => ({ id, tools: 'unknown' as const })) };
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

export const detectLocalServers = async (options: DetectLocalServersOptions): Promise<DetectedLocalServer[]> => {
  const fetchFn = options.fetch;
  const loopback = options.candidates.filter((candidate) => isLoopbackHost(new URL(candidate).hostname));
  const addresses = [...new Set([...loopback, ...options.typed])];
  const found: DetectedLocalServer[] = [];
  for (const address of addresses) {
    if (options.signal.aborted) break;
    const server = await detectOne(address, fetchFn, options.signal);
    if (server !== undefined) found.push(server);
  }
  return found;
};
