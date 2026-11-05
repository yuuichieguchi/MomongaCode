import { describe, expect, it } from 'vitest';
import { MAX_JSON_DEPTH } from '@momonga/foundation';
import { UpdateError } from '../src/update/errors.ts';
import type { HttpResponse, UpdateHttp } from '../src/update/ports.ts';
import { fetchLatestRelease } from '../src/update/release.ts';
import type { UpdateSource } from '../src/update/source.ts';

const nestedArraysText = (depth: number): string => `${'['.repeat(depth)}${']'.repeat(depth)}`;

const releaseText = (depth: number): string => `{"tag_name":"v9.8.7","extra":${nestedArraysText(depth - 1)}}`;

const answering = (text: string): UpdateHttp => ({
  get: async (): Promise<HttpResponse> => ({
    status: 200,
    body: (async function* () {
      yield new TextEncoder().encode(text);
    })(),
  }),
});

const SOURCE = { repo: 'owner/repo', endpoints: { apiBaseUrl: 'https://api.example.test' } } as unknown as UpdateSource;

const lookup = (text: string) => fetchLatestRelease({ http: answering(text), version: '1.0.0' }, SOURCE, new AbortController().signal);

describe('the latest release answer and the one JSON depth bound', () => {
  it(`reads a release answer nested exactly ${MAX_JSON_DEPTH} deep`, async () => {
    expect((await lookup(releaseText(MAX_JSON_DEPTH))).tag).toBe('v9.8.7');
  });

  it(`refuses a release answer nested ${MAX_JSON_DEPTH + 1} deep as malformed, naming the depth`, async () => {
    const error = await lookup(releaseText(MAX_JSON_DEPTH + 1)).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(UpdateError);
    expect((error as UpdateError).code).toBe('release_malformed');
    expect((error as Error).message).toMatch(/depth/i);
    expect((error as Error).message).toContain(String(MAX_JSON_DEPTH));
  });
});
