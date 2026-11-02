import { isRecord } from '@momonga/foundation';
import { UpdateError } from './errors.ts';
import type { UpdateErrorCode } from './errors.ts';
import type { HttpResponse, UpdatePorts } from './ports.ts';
import type { UpdateSource } from './source.ts';
import { compareVersions, parseReleaseTag, parseVersion } from './version.ts';
import type { Version } from './version.ts';

export type Release = { tag: string; version: Version };

export type UpdateCheck =
  | { kind: 'up_to_date'; current: Version }
  | { kind: 'ahead'; current: Version; latest: Release }
  | { kind: 'available'; current: Version; latest: Release };

export const requestHeaders = (ports: Pick<UpdatePorts, 'version'>): Record<string, string> => ({
  accept: 'application/vnd.github+json',
  'user-agent': `momonga/${ports.version}`,
  'x-github-api-version': '2022-11-28',
});

export const discardBody = async (response: HttpResponse): Promise<void> => {
  for await (const chunk of response.body) void chunk;
};

export const requestOrFail = async (
  ports: Pick<UpdatePorts, 'http' | 'version'>,
  url: string,
  signal: AbortSignal,
  code: UpdateErrorCode,
  what: string,
): Promise<HttpResponse> => {
  let response: HttpResponse;
  try {
    response = await ports.http.get(url, { headers: requestHeaders(ports), signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new UpdateError(code, `${what} failed: ${error instanceof Error ? error.message : String(error)}`, { detail: url, cause: error });
  }
  if (response.status !== 200) {
    await discardBody(response);
    throw new UpdateError(code, `${what} failed: HTTP ${response.status}`, { detail: url });
  }
  return response;
};

export const readText = async (response: HttpResponse, signal: AbortSignal, code: UpdateErrorCode, what: string): Promise<string> => {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let text = '';
  try {
    for await (const chunk of response.body) text += decoder.decode(chunk, { stream: true });
    return text + decoder.decode();
  } catch (error) {
    if (signal.aborted) throw error;
    throw new UpdateError(code, `${what} failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
};

export const fetchLatestRelease = async (ports: Pick<UpdatePorts, 'http' | 'version'>, source: UpdateSource, signal: AbortSignal): Promise<Release> => {
  const url = `${source.endpoints.apiBaseUrl}/repos/${source.repo}/releases/latest`;
  const what = 'looking up the latest release';
  const response = await requestOrFail(ports, url, signal, 'release_lookup_failed', what);
  const body = await readText(response, signal, 'release_lookup_failed', what);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (error) {
    throw new UpdateError('release_malformed', 'the latest release response is not JSON', { detail: url, cause: error });
  }
  if (!isRecord(parsed) || typeof parsed['tag_name'] !== 'string') {
    throw new UpdateError('release_malformed', 'the latest release response has no tag_name', { detail: url });
  }
  return { tag: parsed['tag_name'], version: parseReleaseTag(parsed['tag_name']) };
};

export const checkForUpdate = async (ports: Pick<UpdatePorts, 'http' | 'version'>, source: UpdateSource, signal: AbortSignal): Promise<UpdateCheck> => {
  const current = parseVersion(ports.version, 'the running version');
  const latest = await fetchLatestRelease(ports, source, signal);
  const order = compareVersions(latest.version, current);
  if (order === 0) return { kind: 'up_to_date', current };
  return order > 0 ? { kind: 'available', current, latest } : { kind: 'ahead', current, latest };
};
