import { describe, expect, it } from 'vitest';
import { loadEndpointRecord, probeEndpointTarget } from '@momonga/gateway';
import { startFake } from './cc-support.ts';
import { makeDir } from './gateway-helpers.ts';

const MODELS = [{ id: 'qwen-fake', object: 'model', created: 1_700_000_000, owned_by: 'library' }];

describe('probeEndpointTarget', () => {
  it('measures an endpoint that is not fm and records it under the endpoint, the model and the identity the server exposes', async () => {
    const fake = await startFake({ scenario: 'tools-ok', modelId: 'qwen-fake', models: MODELS, parallelToolCalls: true, reasoning: { tokens: 120, effort: 'honoured' } });
    const dir = makeDir();

    const result = await probeEndpointTarget({
      probeRecordDir: dir,
      upstream: { kind: 'unix', socketPath: fake.socketPath },
      model: 'qwen-fake',
      apiKey: undefined,
      samples: 3,
    });

    expect(result.toolCalling).toBe('native');
    expect(result.report.parallelToolCalls).toEqual({ accepted: true, multiCallRate: 1 });
    expect(result.report.reasoning).toEqual({ control: 'reasoning_effort', lowest: 'none' });
    expect(result.key).toEqual({ endpoint: `unix:${fake.socketPath}`, model: 'qwen-fake' });
    const stored = await loadEndpointRecord(dir, result.key);
    expect(stored?.report).toEqual(result.report);
    expect(stored?.identity).toBe(result.identity);
    expect(result.identity).not.toBe('');
  });

  it('probes the model of the target, not the first one the server lists', async () => {
    const fake = await startFake({ scenario: 'tools-ok', modelId: 'qwen-fake', models: [{ id: 'listed-first' }, ...MODELS] });

    await probeEndpointTarget({ probeRecordDir: makeDir(), upstream: { kind: 'unix', socketPath: fake.socketPath }, model: 'qwen-fake', apiKey: undefined, samples: 1 });

    const chatBodies = fake.requests.filter((request) => request.path === '/v1/chat/completions').map((request) => request.body as { model: string });
    expect(chatBodies.length).toBeGreaterThan(0);
    expect(chatBodies.every((body) => body.model === 'qwen-fake')).toBe(true);
  });

  it('never asks a chat-completions target for /health, whatever the transport', async () => {
    const fake = await startFake({ scenario: 'tools-ok', modelId: 'qwen-fake', models: MODELS });

    await probeEndpointTarget({ probeRecordDir: makeDir(), upstream: { kind: 'unix', socketPath: fake.socketPath }, model: 'qwen-fake', apiKey: undefined, samples: 1 });

    expect(fake.requests.filter((request) => request.path === '/health')).toEqual([]);
    expect(fake.requests.filter((request) => request.path === '/v1/models').length).toBeGreaterThan(0);
  });

  it('records the constrained mode for an endpoint whose native tool calls are unreliable', async () => {
    const fake = await startFake({ scenario: 'tools-ok', modelId: 'qwen-fake', models: MODELS, nativeValidity: 0.2 });

    const result = await probeEndpointTarget({ probeRecordDir: makeDir(), upstream: { kind: 'unix', socketPath: fake.socketPath }, model: 'qwen-fake', apiKey: undefined, samples: 5 });

    expect(result.toolCalling).toBe('constrained');
  });
});
