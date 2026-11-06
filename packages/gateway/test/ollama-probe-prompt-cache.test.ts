import { describe, expect, it } from 'vitest';
import { endpointKeyOf, loadEndpointRecord, probeOllamaTarget } from '@momonga/gateway';
import type { Capabilities } from '@momonga/protocol';
import { isOllamaProbeReport } from '../src/probe/report-schema.ts';
import { createProbedOllamaTarget } from '../src/probe/ollama-target.ts';
import { makeDir } from './gateway-helpers.ts';
import { OLLAMA_CAPABILITIES, OLLAMA_MODEL, startFakeOllama } from './ollama-support.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';

const probeWith = async (cacheProbe: 'automatic' | 'none' | 'unreported') => {
  const fake = await startFakeOllama({ cacheProbe });
  const dir = makeDir();
  const result = await probeOllamaTarget({ probeRecordDir: dir, upstream: { kind: 'tcp', baseUrl: fake.origin }, key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_MODEL }, model: OLLAMA_MODEL, contextWindow: 32768 });
  return { fake, dir, result };
};

describe('the Ollama probe measures the prompt cache from a repeated /api/chat', () => {
  it('sends the same chat body twice and records automatic when the second reports cached tokens', async () => {
    const { fake, result } = await probeWith('automatic');
    const bodies = fake.chatBodies().filter((body) => body.format === undefined);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(result.report.promptCache).toEqual({ kind: 'automatic' });
    expect(isOllamaProbeReport(result.report)).toBe(true);
  });

  it('records none when the second answer reports zero cached tokens', async () => {
    const { result } = await probeWith('none');
    expect(result.report.promptCache).toEqual({ kind: 'none' });
  });

  it('records nothing when the answer carries no cached count, and saves a valid record', async () => {
    const { dir, result } = await probeWith('unreported');
    expect(result.report).not.toHaveProperty('promptCache');
    expect((await loadEndpointRecord(dir, result.key, CURRENT_DIALECTS))?.report).toEqual(result.report);
  });
});

describe('the Ollama cache probe builds its chat body with the adapter body builder (S2)', () => {
  it('sends truncate false, num_ctx equal to the context window and an output limit of one token', async () => {
    const { fake } = await probeWith('automatic');
    const bodies = fake.chatBodies().filter((body) => body.format === undefined);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.model).toBe(OLLAMA_MODEL);
      expect(body.stream).toBe(false);
      expect(body.truncate).toBe(false);
      expect(body.options.num_ctx).toBe(32768);
      expect(body.options.num_predict).toBe(1);
    }
  });
});

describe('the probed Ollama cache becomes the capability unless declared', () => {
  const targetFor = async (declared: Capabilities) => {
    const { dir, result } = await probeWith('automatic');
    const record = await loadEndpointRecord(dir, result.key, CURRENT_DIALECTS);
    return createProbedOllamaTarget({
      targetName: 'local',
      endpoint: result.key.endpoint,
      model: OLLAMA_MODEL,
      declared,
      record: record as never,
      readDigest: async () => result.identity,
    });
  };

  it('carries the recorded cache', async () => {
    expect((await (await targetFor(OLLAMA_CAPABILITIES)).capabilities()).promptCache).toEqual({ kind: 'automatic' });
  });

  it('keeps a declared cache over the recorded one', async () => {
    expect((await (await targetFor({ ...OLLAMA_CAPABILITIES, promptCache: { kind: 'none' } })).capabilities()).promptCache).toEqual({ kind: 'none' });
  });
});
