import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import { describe, expect, it } from 'vitest';
import { endpointKeyOf, loadEndpointRecord, probeOllamaTarget, runProbe } from '@momonga/gateway';
import type { AdapterRequest, Capabilities, ReasoningEffort } from '@momonga/protocol';
import { startFakeChatCompletions, testKernelLock } from '@momonga/testkit';
import { buildOllamaBody } from '../src/adapters/ollama/request.ts';
import type { DeclaredCapabilities } from '../src/probe/decide.ts';
import { createProbedEndpointTarget } from '../src/probe/endpoint-target.ts';
import { createProbedOllamaTarget } from '../src/probe/ollama-target.ts';
import { makeDir } from './gateway-helpers.ts';
import { OLLAMA_CAPABILITIES, OLLAMA_MODEL, fixtureJson, startFakeOllama } from './ollama-support.ts';
import { CURRENT_DIALECTS } from './dialect-currency.ts';
import { NO_PROBE_START } from './fm-record-support.ts';
import { UNCONFIGURED_NETWORK } from '@momonga/testkit';
import { hostProbePorts, probePortsAt } from './probe-ports-support.ts';

const RECORDED_SHOW = fixtureJson('api-show.json');

const showWith = (capabilities: readonly string[]) => ({ ...RECORDED_SHOW, capabilities });

const probedTarget = async (showCapabilities: readonly string[], declared: DeclaredCapabilities, cacheProbe: 'automatic' | 'none' = 'none') => {
  const fake = await startFakeOllama({ show: showWith(showCapabilities), cacheProbe });
  const dir = makeDir();
  const result = await probeOllamaTarget({ ports: hostProbePorts, lock: testKernelLock(), probeRecordDir: dir, upstream: { kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK }, key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_MODEL }, model: OLLAMA_MODEL, contextWindow: 12288 });
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

const askedWith = (effort: ReasoningEffort): AdapterRequest => ({
  model: OLLAMA_MODEL,
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  max_output_tokens: 300,
  reasoning_effort: effort,
});

describe('the Ollama probe report is merged into the capabilities (W2)', () => {
  it.for(['minimal', 'low', 'medium', 'high'] as const)('sends no think true at effort %s to a target whose probe found no thinking', async (effort) => {
    const target = await probedTarget(['completion', 'tools'], OLLAMA_CAPABILITIES);
    const body = buildOllamaBody(askedWith(effort), await target.capabilities(), undefined, EVERY_REASONING_IS_OWN);
    expect(body.think).not.toBe(true);
  });

  it('sends think true at effort high to a target whose probe found thinking', async () => {
    const target = await probedTarget(['completion', 'tools', 'thinking'], OLLAMA_CAPABILITIES);
    const capabilities = await target.capabilities();
    expect(capabilities.reasoning).toBeDefined();
    expect(buildOllamaBody(askedWith('high'), capabilities, undefined, EVERY_REASONING_IS_OWN).think).toBe(true);
  });

  it('keeps the declared image input of a target whose probe found no vision', async () => {
    const target = await probedTarget(['completion', 'tools'], OLLAMA_CAPABILITIES);
    const capabilities = await target.capabilities();
    expect(OLLAMA_CAPABILITIES.imageInput).toBe(true);
    expect(capabilities.imageInput).toBe(true);
    expect(capabilities.imageTokens).toEqual(OLLAMA_CAPABILITIES.imageTokens);
  });

  it('keeps the declared image input of a target whose probe found vision', async () => {
    const target = await probedTarget(['completion', 'tools', 'vision'], OLLAMA_CAPABILITIES);
    const capabilities = await target.capabilities();
    expect(capabilities.imageInput).toBe(true);
    expect(capabilities.imageTokens).toEqual(OLLAMA_CAPABILITIES.imageTokens);
  });
});

const { imageInput: _imageInput, imageTokens: _imageTokens, ...UNDECLARED_IMAGE } = OLLAMA_CAPABILITIES;

describe('image input of an Ollama target follows the declaration, then the probe (decision 1)', () => {
  it('follows the probe and its measured image token model when the settings declare no image input', async () => {
    const capabilities = await (await probedTarget(['completion', 'tools', 'vision'], UNDECLARED_IMAGE)).capabilities();
    expect(capabilities.imageInput).toBe(true);
    expect(capabilities.imageTokens).toMatchObject({ minTokens: 1, maxTokens: 1600 });
  });

  it('has no image input when the settings declare none and the probe found no vision', async () => {
    const capabilities = await (await probedTarget(['completion', 'tools'], UNDECLARED_IMAGE)).capabilities();
    expect(capabilities.imageInput).toBe(false);
    expect(capabilities.imageTokens).toBeUndefined();
  });

  it('keeps a declared imageInput false over a probe that found vision', async () => {
    const capabilities = await (await probedTarget(['completion', 'tools', 'vision'], { ...UNDECLARED_IMAGE, imageInput: false })).capabilities();
    expect(capabilities.imageInput).toBe(false);
  });
});

describe('one merge decides a declared against a probed prompt cache for every probed adapter (W4)', () => {
  const endpointTargetWith = async (declared: Capabilities) => {
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', streamUsage: true });
    try {
      const report = { ...(await runProbe({ socketPath: fake.socketPath, samples: 2, ports: probePortsAt(() => new Date('2026-11-05T12:00:00.000Z')) })), promptCache: { kind: 'automatic' as const } };
      return createProbedEndpointTarget({ written: declared,
        toolCalling: 'auto', readReported: async () => ({}), displayOf: () => 'remote',
        endpoint: 'unix:/nowhere',
        model: 'm',
        declared,
        record: { identity: 'id', identityFields: [], report },
        readRecord: async () => ({ identity: 'id', identityFields: [], report }),
        startProbe: NO_PROBE_START,
        readIdentity: async () => 'id',
        saveRecord: async () => undefined,
      });
    } finally {
      await fake.close();
    }
  };

  it.for([{ kind: 'key' }, { kind: 'none' }] as const)('keeps a declared $kind over a probed automatic on a chat-completions and an ollama target alike', async (declaredCache) => {
    const declared: Capabilities = { ...OLLAMA_CAPABILITIES, promptCache: declaredCache };
    const ollama = await probedTarget(['completion', 'tools'], declared, 'automatic');
    const endpoint = await endpointTargetWith(declared);
    expect((await ollama.capabilities()).promptCache).toEqual(declaredCache);
    expect((await endpoint.capabilities()).promptCache).toEqual(declaredCache);
  });

  it('gives the probed automatic to a chat-completions and an ollama target that declare no cache', async () => {
    const ollama = await probedTarget(['completion', 'tools'], OLLAMA_CAPABILITIES, 'automatic');
    const endpoint = await endpointTargetWith(OLLAMA_CAPABILITIES);
    expect((await ollama.capabilities()).promptCache).toEqual({ kind: 'automatic' });
    expect((await endpoint.capabilities()).promptCache).toEqual({ kind: 'automatic' });
  });
});
