import { describe, expect, it } from 'vitest';
import { OLLAMA_MINIMUM_VERSION, loadEndpointRecord, probeOllamaTarget } from '@momonga/gateway';
import { makeDir } from './gateway-helpers.ts';
import {
  OLLAMA_MODEL,
  PLACEHOLDER_TAGS_DIGEST,
  PLACEHOLDER_TAGS_DIGEST_AFTER_PULL,
  RECORDED_SERVER_VERSION,
  TRAINED_CONTEXT_LENGTH,
  placeholderTagsListing,
  startFakeOllama,
} from './ollama-support.ts';

const probe = (origin: string, dir: string, contextWindow: number) =>
  probeOllamaTarget({ probeRecordDir: dir, upstream: { kind: 'tcp', baseUrl: origin }, model: OLLAMA_MODEL, contextWindow });

describe('the Ollama probe', () => {
  it('reads /api/version, /api/show for the model and /api/tags, and records the digest as the upstream identity', async () => {
    const fake = await startFakeOllama();
    const dir = makeDir();

    const result = await probe(fake.origin, dir, 32768);

    expect(fake.requests.map((request) => `${request.method} ${request.path}`).sort()).toEqual(['GET /api/tags', 'GET /api/version', 'POST /api/show']);
    expect(fake.requests.find((request) => request.path === '/api/show')?.body).toMatchObject({ model: OLLAMA_MODEL });
    expect(result.identity).toBe(PLACEHOLDER_TAGS_DIGEST);
    expect(result.key).toEqual({ endpoint: fake.origin, model: OLLAMA_MODEL });
    const stored = await loadEndpointRecord(dir, result.key);
    expect(stored?.identity).toBe(PLACEHOLDER_TAGS_DIGEST);
    expect(stored?.report).toEqual(result.report);
  });

  it('records the trained context length the server reports, with the window method reported, and the capabilities of /api/show', async () => {
    const fake = await startFakeOllama();

    const { report } = await probe(fake.origin, makeDir(), 32768);

    expect(report.contextWindow).toMatchObject({ value: TRAINED_CONTEXT_LENGTH, method: 'reported' });
    expect(report.nativeTools.accepted).toBe(true);
    expect(report.imageInputAccepted).toBe(true);
  });

  it('accepts a window equal to the trained length', async () => {
    const fake = await startFakeOllama();
    await expect(probe(fake.origin, makeDir(), TRAINED_CONTEXT_LENGTH)).resolves.toMatchObject({ identity: PLACEHOLDER_TAGS_DIGEST });
  });

  it('rejects a window above the trained length and saves no record', async () => {
    const fake = await startFakeOllama();
    const dir = makeDir();

    await expect(probe(fake.origin, dir, TRAINED_CONTEXT_LENGTH + 1)).rejects.toThrow(String(TRAINED_CONTEXT_LENGTH));
    expect(await loadEndpointRecord(dir, { endpoint: fake.origin, model: OLLAMA_MODEL })).toBeNull();
  });

  it('accepts the server version whose tool calls were measured to carry ids', async () => {
    const fake = await startFakeOllama({ version: { status: 200, body: { version: RECORDED_SERVER_VERSION } } });
    await expect(probe(fake.origin, makeDir(), 32768)).resolves.toMatchObject({ identity: PLACEHOLDER_TAGS_DIGEST });
    expect(typeof OLLAMA_MINIMUM_VERSION).toBe('string');
  });

  it('rejects a server version below the minimum and names the minimum', async () => {
    const fake = await startFakeOllama({ version: { status: 200, body: { version: '0.0.1' } } });
    const dir = makeDir();

    await expect(probe(fake.origin, dir, 32768)).rejects.toThrow(OLLAMA_MINIMUM_VERSION);
    expect(await loadEndpointRecord(dir, { endpoint: fake.origin, model: OLLAMA_MODEL })).toBeNull();
  });

  it('records a new identity after the model is pulled again under the same tag', async () => {
    let digest = PLACEHOLDER_TAGS_DIGEST;
    const fake = await startFakeOllama({ tags: () => placeholderTagsListing(digest) });
    const dir = makeDir();

    const first = await probe(fake.origin, dir, 32768);
    digest = PLACEHOLDER_TAGS_DIGEST_AFTER_PULL;
    const second = await probe(fake.origin, dir, 32768);

    expect(first.identity).toBe(PLACEHOLDER_TAGS_DIGEST);
    expect(second.identity).toBe(PLACEHOLDER_TAGS_DIGEST_AFTER_PULL);
    expect((await loadEndpointRecord(dir, second.key))?.identity).toBe(PLACEHOLDER_TAGS_DIGEST_AFTER_PULL);
  });
});
