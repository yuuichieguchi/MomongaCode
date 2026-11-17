import { describe, expect, it } from 'vitest';
import { endpointKeyOf, loadEndpointRecord, probeOllamaTarget } from '@momonga/gateway';
import { makeDir } from './gateway-helpers.ts';
import { DEVSTRAL_DIGEST, OLLAMA_MODEL, QWEN_DIGEST, QWEN_MODEL, TRAINED_CONTEXT_LENGTH, startFakeOllama, tagsWithDevstralDigest } from './ollama-support.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';
import { UNCONFIGURED_NETWORK, testKernelLock } from '@momonga/testkit';
import { hostProbePorts } from './probe-ports-support.ts';
import { DeclaredWindowAboveReportedError } from '../src/probe/declared-window.ts';

const probe = (origin: string, dir: string, contextWindow: number, model = OLLAMA_MODEL) =>
  probeOllamaTarget({ ports: hostProbePorts, lock: testKernelLock(), probeRecordDir: dir, upstream: { kind: 'tcp', baseUrl: origin, network: UNCONFIGURED_NETWORK }, key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: origin }), model }, model, contextWindow });

describe('the Ollama probe', () => {
  it('reads /api/version, /api/show for the model and /api/tags, and records the digest as the upstream identity', async () => {
    const fake = await startFakeOllama();
    const dir = makeDir();

    const result = await probe(fake.origin, dir, 32768);

    const withoutDialectStep = fake.requests.filter((request) => !(request.path === '/api/chat' && request.body.format !== undefined));
    expect(withoutDialectStep.map((request) => `${request.method} ${request.path}`).sort()).toEqual(['GET /api/tags', 'GET /api/version', ...Array.from({ length: 7 }, () => 'POST /api/chat'), 'POST /api/show']);
    expect(fake.requests.find((request) => request.path === '/api/show')?.body).toMatchObject({ model: OLLAMA_MODEL });
    expect(result.identity).toBe(DEVSTRAL_DIGEST);
    expect(result.key).toEqual({ endpoint: fake.origin, model: OLLAMA_MODEL });
    const stored = await loadEndpointRecord(dir, result.key, CURRENT_DIALECTS, 'the-model');
    expect(stored?.identity).toBe(DEVSTRAL_DIGEST);
    expect(stored?.report).toEqual(result.report);
  });

  it('sends no measurement request to a metered endpoint the person has not consented to', async () => {
    const fake = await startFakeOllama();
    const dir = makeDir();

    await expect(
      probeOllamaTarget({
        ports: hostProbePorts,
        lock: testKernelLock(),
        probeRecordDir: dir,
        upstream: { kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK },
        key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_MODEL },
        model: OLLAMA_MODEL,
        contextWindow: 32768,
        metered: { displayOf: () => 'ollama/devstral', declaredContextWindow: 32768 },
      }),
    ).rejects.toThrow('measured only with your consent');

    expect(fake.requests).toEqual([]);
  });

  it('matches a model name without a tag to its :latest entry in /api/tags', async () => {
    const fake = await startFakeOllama();
    expect((await probe(fake.origin, makeDir(), 32768, OLLAMA_MODEL)).identity).toBe(DEVSTRAL_DIGEST);
  });

  it('matches a model name with a tag exactly', async () => {
    const fake = await startFakeOllama();
    expect((await probe(fake.origin, makeDir(), 32768, QWEN_MODEL)).identity).toBe(QWEN_DIGEST);
  });

  it('records the trained context length with the window method reported and the capabilities of /api/show, and nothing it does not measure', async () => {
    const fake = await startFakeOllama();

    const { report } = await probe(fake.origin, makeDir(), 32768);

    expect(report.contextWindow).toMatchObject({ value: TRAINED_CONTEXT_LENGTH, method: 'reported' });
    expect(report.nativeTools.accepted).toBe(true);
    expect(report.imageInputAccepted).toBe(true);
    expect('constrained' in report).toBe(false);
    expect('keywordSupport' in report).toBe(false);
    expect('tokenCalibration' in report).toBe(false);
  });

  it('accepts a window equal to the trained length', async () => {
    const fake = await startFakeOllama();
    await expect(probe(fake.origin, makeDir(), TRAINED_CONTEXT_LENGTH)).resolves.toMatchObject({ identity: DEVSTRAL_DIGEST });
  });

  it('refuses a declared window above the trained length with the declared-window rule, naming both numbers', async () => {
    const fake = await startFakeOllama();

    const failure = await probe(fake.origin, makeDir(), TRAINED_CONTEXT_LENGTH + 1).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(DeclaredWindowAboveReportedError);
    expect(String(failure)).toContain(String(TRAINED_CONTEXT_LENGTH + 1));
    expect(String(failure)).toContain(String(TRAINED_CONTEXT_LENGTH));
  });

  it('rejects a window above the trained length and saves no record', async () => {
    const fake = await startFakeOllama();
    const dir = makeDir();

    await expect(probe(fake.origin, dir, TRAINED_CONTEXT_LENGTH + 1)).rejects.toThrow(String(TRAINED_CONTEXT_LENGTH));
    expect(await loadEndpointRecord(dir, { endpoint: fake.origin, model: OLLAMA_MODEL }, CURRENT_DIALECTS, 'the-model')).toBeNull();
  });

  it('records a new identity after the model is pulled again under the same tag', async () => {
    let digest = DEVSTRAL_DIGEST;
    const fake = await startFakeOllama({ tags: () => tagsWithDevstralDigest(digest) });
    const dir = makeDir();

    const first = await probe(fake.origin, dir, 32768);
    digest = QWEN_DIGEST;
    const second = await probe(fake.origin, dir, 32768);

    expect(first.identity).toBe(DEVSTRAL_DIGEST);
    expect(second.identity).toBe(QWEN_DIGEST);
    expect((await loadEndpointRecord(dir, second.key, CURRENT_DIALECTS, 'the-model'))?.identity).toBe(QWEN_DIGEST);
  });
});
