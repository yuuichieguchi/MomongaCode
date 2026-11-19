import { describe, expect, it } from 'vitest';
import { endpointKeyOf, loadEndpointRecord, probeOllamaTarget } from '@momonga/gateway';
import { maxOutputTokensFor } from '@momonga/protocol';
import type { Capabilities } from '@momonga/protocol';
import { isOllamaProbeReport } from '../src/probe/report-schema.ts';
import { createProbedOllamaTarget } from '../src/probe/ollama-target.ts';
import { makeDir } from './gateway-helpers.ts';
import { OLLAMA_CAPABILITIES, OLLAMA_MODEL, startFakeOllama } from './ollama-support.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';
import { NO_PROBE_START } from './fm-record-support.ts';
import { UNCONFIGURED_NETWORK, testKernelLock } from '@momonga/testkit';
import { hostProbePorts } from './probe-ports-support.ts';

const TRAINED_LENGTH = 393216;

const probeWith = async (cacheProbe: 'automatic' | 'none' | 'unreported', stated: { contextWindow?: number } = { contextWindow: 32768 }) => {
  const fake = await startFakeOllama({ cacheProbe });
  const dir = makeDir();
  const result = await probeOllamaTarget({ ports: hostProbePorts, lock: testKernelLock(), probeRecordDir: dir, upstream: { kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK }, key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_MODEL }, model: OLLAMA_MODEL, ...stated });
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
    expect((await loadEndpointRecord(dir, result.key, CURRENT_DIALECTS, 'the-model'))?.report).toEqual(result.report);
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

  it('sends no num_ctx in any probe step when no window is stated, sizes the JSON and dialect steps from the trained length, and sends no load', async () => {
    const { fake, result } = await probeWith('automatic', {});
    const chats = fake.requests.filter((request) => request.path === '/api/chat').map((request) => request.body as { options: Record<string, unknown>; format?: unknown; messages: unknown[] });
    expect(chats.length).toBeGreaterThan(3);
    for (const chat of chats) {
      expect(chat.options).not.toHaveProperty('num_ctx');
      expect(Number.isSafeInteger(chat.options['num_predict'])).toBe(true);
    }
    const formatted = chats.filter((chat) => chat.format !== undefined);
    expect(formatted.length).toBeGreaterThan(0);
    for (const chat of formatted) expect(chat.options['num_predict']).toBe(maxOutputTokensFor(TRAINED_LENGTH));
    expect(fake.requests.filter((request) => request.path === '/api/generate' || request.path === '/api/ps')).toEqual([]);
    expect(result.report.contextWindow).toEqual({ value: TRAINED_LENGTH, method: 'reported' });
  });
});

describe('the probed Ollama cache becomes the capability unless declared', () => {
  const targetFor = async (declared: Capabilities) => {
    const { dir, result } = await probeWith('automatic');
    const record = await loadEndpointRecord(dir, result.key, CURRENT_DIALECTS, 'the-model');
    return createProbedOllamaTarget({ written: declared,
      toolCalling: 'auto', readReported: async () => ({}), displayOf: () => 'local',
      endpoint: result.key.endpoint,
      model: OLLAMA_MODEL,
      declared,
      record: record as never,
      readRecord: async () => record as never,
      startProbe: NO_PROBE_START,
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
