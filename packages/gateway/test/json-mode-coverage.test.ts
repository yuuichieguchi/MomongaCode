import { describe, expect, it } from 'vitest';
import { PROBE_METHOD_VERSION, endpointKeyOf, probeOllamaTarget, runProbe } from '@momonga/gateway';
import type { Capabilities, ProbeReport } from '@momonga/protocol';
import { createFakeClock, createFakeTimers, startFakeChatCompletions, testKernelLock } from '@momonga/testkit';
import { createReasoningOriginCodec } from '../src/core/reasoning-origin.ts';
import { createRedactor } from '../src/core/redaction.ts';
import { createRouter } from '../src/core/router.ts';
import { listModel } from '../src/server/capability-listing.ts';
import { createProbedEndpointTarget } from '../src/probe/endpoint-target.ts';
import { HMAC_KEY, START_MS, buildConfig, makeDir, registerCleanup } from './gateway-helpers.ts';
import { CC_CAPABILITIES, makeAdapter, startFake } from './cc-support.ts';
import { OLLAMA_MODEL, startFakeOllama } from './ollama-support.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';
import { NO_PROBE_START } from './fm-record-support.ts';
import { UNCONFIGURED_NETWORK } from '@momonga/testkit';
import { hostProbePorts, probePortsAt } from './probe-ports-support.ts';

type JsonMode = 'json_object' | 'none' | undefined;

const jsonModeOf = (value: unknown): unknown => (value as { jsonMode?: unknown }).jsonMode;

const withJsonMode = (base: Capabilities, jsonMode: JsonMode): Capabilities => {
  const { jsonMode: _dropped, ...rest } = base as Capabilities & { jsonMode?: unknown };
  return (jsonMode === undefined ? rest : { ...rest, jsonMode }) as Capabilities;
};

const NOW = () => new Date('2026-11-07T12:00:00.000Z');

describe('the probe method version for the JSON-only mode item', () => {
  it('is above 3, so records written by method 3 and earlier follow the method-change rule', () => {
    expect(PROBE_METHOD_VERSION).toBeGreaterThan(3);
  });
});

describe('the Ollama probe measures the JSON-only mode through the same item', () => {
  const probeOllama = async (jsonModeProbe: 'accepts' | 'rejects' | 'ignores' | 'fails'): Promise<unknown> => {
    const fake = await startFakeOllama({ jsonModeProbe });
    const result = await probeOllamaTarget({
      ports: hostProbePorts,
      lock: testKernelLock(),
      probeRecordDir: makeDir(),
      upstream: { kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK },
      key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_MODEL },
      model: OLLAMA_MODEL,
      contextWindow: 32768,
    });
    expect(fake.requests.some((request) => request.path === '/api/chat' && request.body?.format === 'json')).toBe(true);
    return jsonModeOf(result.report);
  };

  it.each([
    ['accepts', 'accepted'],
    ['rejects', 'refused'],
    ['ignores', 'refused'],
    ['fails', 'unmeasured'],
  ] as const)('records the same state as the chat-completions probe when the target %s', async (behaviour, state) => {
    expect(await probeOllama(behaviour)).toBe(state);
  });
});

describe('a probed endpoint target carries the measured JSON-only mode', () => {
  const plainReport = async (): Promise<ProbeReport> => {
    const fake = await startFakeChatCompletions({ scenario: 'tools-ok', streamUsage: true });
    registerCleanup(() => fake.close());
    return runProbe({ socketPath: fake.socketPath, samples: 2, ports: probePortsAt(NOW) });
  };

  const reportWith = async (state: 'accepted' | 'refused' | undefined): Promise<ProbeReport> => {
    const { jsonMode: _drop, ...rest } = (await plainReport()) as ProbeReport & { jsonMode?: unknown };
    return (state === undefined ? rest : { ...rest, jsonMode: state }) as ProbeReport;
  };

  const capabilitiesOf = (declared: Capabilities, report: ProbeReport) =>
    createProbedEndpointTarget({ written: declared,
      toolCalling: 'auto', readReported: async () => ({}), targetName: 'remote',
      endpoint: 'unix:/nowhere',
      model: 'm',
      declared,
      record: { identity: 'id', identityFields: [], report },
      readRecord: async () => ({ identity: 'id', identityFields: [], report }),
      startProbe: NO_PROBE_START,
      readIdentity: async () => 'id',
      saveRecord: async () => undefined,
    }).capabilities();

  it('gives json_object for a recorded accepted, and nothing for a method-2 record without the item', async () => {
    expect(jsonModeOf(await capabilitiesOf(withJsonMode(REMOTE_CAPABILITIES, undefined), await reportWith('accepted')))).toBe('json_object');
    expect(await capabilitiesOf(withJsonMode(REMOTE_CAPABILITIES, undefined), await reportWith(undefined))).not.toHaveProperty('jsonMode');
  });

  it('keeps a declared value over the record in both directions, while an undeclared target takes the record', async () => {
    expect(jsonModeOf(await capabilitiesOf(withJsonMode(REMOTE_CAPABILITIES, undefined), await reportWith('refused')))).toBe('none');
    expect(jsonModeOf(await capabilitiesOf(withJsonMode(REMOTE_CAPABILITIES, 'none'), await reportWith('accepted')))).toBe('none');
    expect(jsonModeOf(await capabilitiesOf(withJsonMode(REMOTE_CAPABILITIES, 'json_object'), await reportWith('refused')))).toBe('json_object');
  });
});

describe('an alias over several targets reports the JSON-only mode every target has', () => {
  const aliasModeOf = async (modes: readonly [JsonMode, JsonMode]): Promise<Capabilities> => {
    const fake = await startFake({ scenario: 'tools-ok', script: [] });
    const router = createRouter({
      config: buildConfig({ chains: { 'scripted/system': ['scripted/system', 'b/system'] }, targets: { 'scripted/system': {}, 'b/system': {} } }),
      adapters: {
        'scripted/system': makeAdapter(fake, { capabilities: async () => withJsonMode(CC_CAPABILITIES, modes[0]) }),
        'b/system': makeAdapter(fake, { capabilities: async () => withJsonMode(CC_CAPABILITIES, modes[1]) }),
      },
      clock: createFakeClock(START_MS),
      timers: createFakeTimers(createFakeClock(START_MS)),
      redactor: createRedactor({ credentials: [] }),
      reasoningOrigin: createReasoningOriginCodec(HMAC_KEY),
    });
    return (await listModel(router, 'scripted/system', new AbortController().signal)).capabilities as Capabilities;
  };

  it('is json_object when every target has it, and absent when one target is unmeasured', async () => {
    expect(jsonModeOf(await aliasModeOf(['json_object', 'json_object']))).toBe('json_object');
    expect(await aliasModeOf(['json_object', undefined])).not.toHaveProperty('jsonMode');
  });

  it('is none when one target lacks it', async () => {
    expect(jsonModeOf(await aliasModeOf(['json_object', 'none']))).toBe('none');
  });
});
