import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILD_DOWNLOAD_LIMIT_MS, downloadWithin } from './node-runtime.ts';

const URL_UNDER_TEST = 'https://example.invalid/dead-network/archive.tar.gz';

const abortedBy = (signal: AbortSignal | null | undefined): Promise<never> =>
  new Promise((_resolve, reject) => {
    if (signal === null || signal === undefined) return;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the build-time download has a bound of its own', () => {
  it('is a fixed limit in milliseconds', () => {
    expect(Number.isSafeInteger(BUILD_DOWNLOAD_LIMIT_MS)).toBe(true);
    expect(BUILD_DOWNLOAD_LIMIT_MS).toBeGreaterThan(0);
  });

  it('stops a request that never answers and names the URL', async () => {
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => abortedBy(init?.signal));
    await expect(downloadWithin(URL_UNDER_TEST, 20)).rejects.toThrow(URL_UNDER_TEST);
  });

  it('stops a body that stalls after the headers and names the URL', async () => {
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => ({ ok: true, status: 200, arrayBuffer: () => abortedBy(init?.signal) }));
    await expect(downloadWithin(URL_UNDER_TEST, 20)).rejects.toThrow(URL_UNDER_TEST);
  });

  it('keeps the HTTP failure message for an answered request', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }));
    await expect(downloadWithin(URL_UNDER_TEST, 1000)).rejects.toThrow(`GET ${URL_UNDER_TEST} failed with HTTP 404`);
  });
});
