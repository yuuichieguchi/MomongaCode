import { describe, expect, it } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import type { Timing } from '@momonga/foundation';
import { endpointKeyOf, probeOllamaTarget } from '@momonga/gateway';
import { UNCONFIGURED_NETWORK, testKernelLock } from '@momonga/testkit';
import { PROBE_STEP_FLOOR_MS, PROBE_STEP_SPEED_MULTIPLE, createProbeClient, speedStepBound } from '../src/probe/client.ts';
import type { ProbePorts } from '../src/probe/client.ts';
import { createRequestGate, personGatedAdapter } from '../src/probe/request-gate.ts';
import { makeDir } from './gateway-helpers.ts';
import { until } from './gateway-process-helpers.ts';
import { OLLAMA_MODEL, chunkLine, collectOllama, doneLine, makeOllamaAdapter, startFakeOllama } from './ollama-support.ts';
import type { FakeOllama } from './ollama-support.ts';

type StepBoundSeen = { chatsBefore: number; boundMs: number };

const answeredChats = (fake: FakeOllama): number => fake.requests.filter((request) => request.path === '/api/chat').length;

const slowServerPorts = (fake: () => FakeOllama, answerMs: number, bounds: StepBoundSeen[]): ProbePorts => {
  const timers: Timing = {
    now: () => systemTiming.now(),
    monotonicMs: () => answeredChats(fake()) * answerMs,
    setTimeout: (callback, ms) => {
      if (ms < PROBE_STEP_FLOOR_MS) return systemTiming.setTimeout(callback, 0);
      bounds.push({ chatsBefore: answeredChats(fake()), boundMs: ms });
      return systemTiming.setTimeout(callback, ms);
    },
    clearTimeout: (handle) => systemTiming.clearTimeout(handle),
  };
  return { clock: systemTiming, timers, gate: createRequestGate() };
};

const measuredAgainst = async (answerMs: number, stepTimeoutMs: number, samples?: number) => {
  const fake = await startFakeOllama({ cacheProbe: 'automatic', jsonModeProbe: 'accepts' });
  const bounds: StepBoundSeen[] = [];
  const result = await probeOllamaTarget({
    ports: slowServerPorts(() => fake, answerMs, bounds),
    stepTimeoutMs,
    lock: testKernelLock(),
    probeRecordDir: makeDir(),
    upstream: { kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK },
    key: { endpoint: endpointKeyOf({ kind: 'tcp', baseUrl: fake.origin }), model: OLLAMA_MODEL },
    model: OLLAMA_MODEL,
    contextWindow: 32768,
    ...(samples === undefined ? {} : { samples }),
  });
  return { fake, bounds, result };
};

describe('a measurement of an Ollama model whose every answer takes 30 s', () => {
  it('ends with one record, each chat step bounded by the slowest observed answer times the stated multiple and never above --step-timeout', async () => {
    const answerMs = 30_000;
    const stepTimeoutMs = 600_000;
    const { fake, bounds, result } = await measuredAgainst(answerMs, stepTimeoutMs, 1);

    expect(result.report.kind).toBe('ollama');
    const chatBounds = bounds.filter((seen) => seen.chatsBefore >= 1);
    expect(chatBounds.length).toBeGreaterThan(0);
    for (const seen of bounds) expect(seen.boundMs).toBeLessThanOrEqual(stepTimeoutMs);
    const firstChat = bounds.find((seen) => seen.chatsBefore === 0 && seen.boundMs === stepTimeoutMs);
    expect(firstChat).toBeDefined();
    const derived = chatBounds.filter((seen) => seen.chatsBefore >= 2);
    expect(derived.length).toBeGreaterThan(0);
    for (const seen of derived) {
      expect(seen.boundMs).toBeGreaterThanOrEqual(answerMs * PROBE_STEP_SPEED_MULTIPLE);
      expect(seen.boundMs).toBeLessThanOrEqual(stepTimeoutMs);
    }
    expect(fake.requests.filter((request) => request.path === '/api/chat').length).toBe(answeredChats(fake));
  });
});

describe('the requests one measurement sends to an Ollama server whose every answer takes 10 s', () => {
  it('are 22 chats among 25 requests with the default samples, so the measurement takes 220 s of the server and no step is bounded above the default --step-timeout', async () => {
    const answerMs = 10_000;
    const stepTimeoutMs = 120_000;
    const { fake, bounds } = await measuredAgainst(answerMs, stepTimeoutMs);

    const chats = answeredChats(fake);
    expect({ chats, all: fake.requests.length }).toEqual({ chats: 22, all: 25 });
    expect(chats * answerMs).toBe(220_000);
    for (const seen of bounds) expect(seen.boundMs).toBeLessThanOrEqual(stepTimeoutMs);
  });
});

describe('a request of the person through a whole adapter while a measurement request is in flight at the same server', () => {
  it('aborts the measurement request, is answered first, and the measurement is sent again after it', async () => {
    const fake = await startFakeOllama({
      chat: [
        { kind: 'hang', lines: [] },
        { kind: 'ndjson', lines: [chunkLine({ content: 'served' }), doneLine()] },
        { kind: 'ndjson', lines: [doneLine()] },
      ],
    });
    const gate = createRequestGate();
    const client = createProbeClient({ kind: 'tcp', baseUrl: fake.origin, network: UNCONFIGURED_NETWORK }, { signal: undefined, bound: speedStepBound(20_000), timers: systemTiming, gate });
    const adapter = personGatedAdapter(makeOllamaAdapter(fake), gate);

    const measured = client.request('POST', '/api/chat', { model: OLLAMA_MODEL, messages: [{ role: 'user', content: 'measure' }], stream: true });
    await until(() => answeredChats(fake) === 1, 'the measurement request reached the server');

    const person = await collectOllama(adapter, { model: OLLAMA_MODEL, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }] });
    expect(person.error).toBeUndefined();
    expect(JSON.stringify(person.events)).toContain('served');
    expect(fake.closedChats()).toBeGreaterThanOrEqual(1);

    expect((await measured).status).toBe(200);
    const order = fake.requests.filter((request) => request.path === '/api/chat').map((request) => JSON.stringify(request.body).includes('measure'));
    expect(order).toEqual([true, false, true]);
    await client.close();
  });
});
