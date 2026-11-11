import { describe, expect, it } from 'vitest';
import { endpointKeyOf, loadEndpointRecord, probeEndpointTarget } from '@momonga/gateway';
import { classifyChatCompletionsError } from '../src/adapters/chat-completions/classify.ts';
import { readEndpointIdentity } from '../src/probe/endpoint-target.ts';
import { startFake } from './cc-support.ts';
import { makeDir } from './gateway-helpers.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';
import { testKernelLock } from '@momonga/testkit';
import { hostProbePorts } from './probe-ports-support.ts';

const MODELS = [{ id: 'qwen-fake', object: 'model', created: 1_700_000_000, owned_by: 'library' }];

describe('probeEndpointTarget', () => {
  it('measures an endpoint that is not fm and records it under the endpoint, the model and the identity the server exposes', async () => {
    const fake = await startFake({ scenario: 'tools-ok', modelId: 'qwen-fake', models: MODELS, parallelToolCalls: true, reasoning: { tokens: 120, effort: 'honoured' } });
    const dir = makeDir();

    const result = await probeEndpointTarget({
      ports: hostProbePorts,
      lock: testKernelLock(),
      probeRecordDir: dir,
      upstream: { kind: 'unix', socketPath: fake.socketPath }, key: { endpoint: endpointKeyOf({ kind: 'unix', socketPath: fake.socketPath }), model: 'qwen-fake' }, model: 'qwen-fake',
      apiKey: undefined,
      samples: 3,
    });

    expect(result.toolCalling).toBe('native');
    expect(result.report.parallelToolCalls).toEqual({ accepted: true, multiCallRate: 1 });
    expect(result.report.reasoning).toEqual({ control: 'reasoning_effort', lowest: 'none' });
    expect(result.key).toEqual({ endpoint: `unix:${fake.socketPath}`, model: 'qwen-fake' });
    const stored = await loadEndpointRecord(dir, result.key, CURRENT_DIALECTS);
    expect(stored?.report).toEqual(result.report);
    expect(stored?.identity).toBe(result.identity);
    expect(result.identity).not.toBe('');
  });

  it('drops from the identity a field the server stamps afresh on every listing, as vLLM does with created', async () => {
    let stamp = 1_700_000_000;
    const fake = await startFake({ scenario: 'tools-ok', modelId: 'qwen-fake', models: () => [{ id: 'qwen-fake', object: 'model', created: (stamp += 7), owned_by: 'vllm' }] });
    const dir = makeDir();

    const result = await probeEndpointTarget({ ports: hostProbePorts, lock: testKernelLock(), probeRecordDir: dir, upstream: { kind: 'unix', socketPath: fake.socketPath }, key: { endpoint: endpointKeyOf({ kind: 'unix', socketPath: fake.socketPath }), model: 'qwen-fake' }, model: 'qwen-fake', apiKey: undefined, samples: 1 });

    expect(result.identityFields).toEqual(['id', 'object', 'owned_by']);
    expect((await loadEndpointRecord(dir, result.key, CURRENT_DIALECTS))?.identityFields).toEqual(['id', 'object', 'owned_by']);
  });

  it('keeps in the identity every field that stays put, as Ollama does with created', async () => {
    const fake = await startFake({ scenario: 'tools-ok', modelId: 'qwen-fake', models: MODELS });
    const dir = makeDir();

    const result = await probeEndpointTarget({ ports: hostProbePorts, lock: testKernelLock(), probeRecordDir: dir, upstream: { kind: 'unix', socketPath: fake.socketPath }, key: { endpoint: endpointKeyOf({ kind: 'unix', socketPath: fake.socketPath }), model: 'qwen-fake' }, model: 'qwen-fake', apiKey: undefined, samples: 1 });

    expect(result.identityFields).toEqual(['created', 'id', 'object', 'owned_by']);
    expect((await loadEndpointRecord(dir, result.key, CURRENT_DIALECTS))?.identity).toBe(result.identity);
  });

  it('reads the listing twice, the second time after the measurements', async () => {
    const fake = await startFake({ scenario: 'tools-ok', modelId: 'qwen-fake', models: MODELS });

    await probeEndpointTarget({ ports: hostProbePorts, lock: testKernelLock(), probeRecordDir: makeDir(), upstream: { kind: 'unix', socketPath: fake.socketPath }, key: { endpoint: endpointKeyOf({ kind: 'unix', socketPath: fake.socketPath }), model: 'qwen-fake' }, model: 'qwen-fake', apiKey: undefined, samples: 1 });

    const paths = fake.requests.map((request) => request.path);
    expect(paths.at(-1)).toBe('/v1/models');
    expect(paths.filter((path) => path === '/v1/models').length).toBeGreaterThanOrEqual(3);
  });

  it('probes the model of the target, not the first one the server lists', async () => {
    const fake = await startFake({ scenario: 'tools-ok', modelId: 'qwen-fake', models: [{ id: 'listed-first' }, ...MODELS] });

    await probeEndpointTarget({ ports: hostProbePorts, lock: testKernelLock(), probeRecordDir: makeDir(), upstream: { kind: 'unix', socketPath: fake.socketPath }, key: { endpoint: endpointKeyOf({ kind: 'unix', socketPath: fake.socketPath }), model: 'qwen-fake' }, model: 'qwen-fake', apiKey: undefined, samples: 1 });

    const chatBodies = fake.requests.filter((request) => request.path === '/v1/chat/completions').map((request) => request.body as { model: string });
    expect(chatBodies.length).toBeGreaterThan(0);
    expect(chatBodies.every((body) => body.model === 'qwen-fake')).toBe(true);
  });

  it('refuses to probe a model the server does not list and saves no record', async () => {
    const fake = await startFake({ scenario: 'tools-ok', modelId: 'qwen-fake', models: [{ id: 'other', object: 'model' }] });
    const dir = makeDir();
    const key = { endpoint: endpointKeyOf({ kind: 'unix', socketPath: fake.socketPath }), model: 'qwen-fake' };

    await expect(
      probeEndpointTarget({ ports: hostProbePorts, lock: testKernelLock(), probeRecordDir: dir, upstream: { kind: 'unix', socketPath: fake.socketPath }, key, model: 'qwen-fake', apiKey: undefined, samples: 1 }),
    ).rejects.toThrow(/does not list/);
    expect(await loadEndpointRecord(dir, key, CURRENT_DIALECTS)).toBeNull();
  });

  it('never asks a chat-completions target for /health, whatever the transport', async () => {
    const fake = await startFake({ scenario: 'tools-ok', modelId: 'qwen-fake', models: MODELS });

    await probeEndpointTarget({ ports: hostProbePorts, lock: testKernelLock(), probeRecordDir: makeDir(), upstream: { kind: 'unix', socketPath: fake.socketPath }, key: { endpoint: endpointKeyOf({ kind: 'unix', socketPath: fake.socketPath }), model: 'qwen-fake' }, model: 'qwen-fake', apiKey: undefined, samples: 1 });

    expect(fake.requests.filter((request) => request.path === '/health')).toEqual([]);
    expect(fake.requests.filter((request) => request.path === '/v1/models').length).toBeGreaterThan(0);
  });

  it('records the constrained mode for an endpoint whose native tool calls are unreliable', async () => {
    const fake = await startFake({ scenario: 'tools-ok', modelId: 'qwen-fake', models: MODELS, nativeValidity: 0.2 });

    const result = await probeEndpointTarget({ ports: hostProbePorts, lock: testKernelLock(), probeRecordDir: makeDir(), upstream: { kind: 'unix', socketPath: fake.socketPath }, key: { endpoint: endpointKeyOf({ kind: 'unix', socketPath: fake.socketPath }), model: 'qwen-fake' }, model: 'qwen-fake', apiKey: undefined, samples: 5 });

    expect(result.toolCalling).toBe('constrained');
  });
});

describe('readEndpointIdentity failures', () => {
  it('refuses when the server does not list the model, never answering with an empty identity', async () => {
    const fake = await startFake({ scenario: 'tools-ok', models: [{ id: 'other' }] });

    await expect(readEndpointIdentity({ kind: 'unix', socketPath: fake.socketPath }, 'qwen-fake', [], hostProbePorts, new AbortController().signal)).rejects.toThrow(/does not list/);
  });

  it('classifies a listing that does not answer within the bound as an unreachable provider', async () => {
    const fake = await startFake({ scenario: 'tools-ok', modelsReply: { kind: 'hang' } });

    const error = await readEndpointIdentity({ kind: 'unix', socketPath: fake.socketPath }, 'qwen-fake', ['id'], hostProbePorts, new AbortController().signal, 100).catch(
      (caught: unknown) => caught,
    );

    expect(classifyChatCompletionsError(error)).toMatchObject({ retryable: true, error: { type: 'server_error', code: 'provider_unavailable' } });
  });

  it('names only the status when the listing is refused', async () => {
    const fake = await startFake({ scenario: 'tools-ok', modelsReply: { kind: 'error', status: 500, body: { detail: 'internal path /srv/models/secret' } } });

    const error = await readEndpointIdentity({ kind: 'unix', socketPath: fake.socketPath }, 'qwen-fake', ['id'], hostProbePorts, new AbortController().signal).catch(
      (caught: unknown) => caught,
    );

    const classified = classifyChatCompletionsError(error);
    expect(classified.error.message).toContain('500');
    expect(classified.error.message).not.toContain('secret');
  });
});
