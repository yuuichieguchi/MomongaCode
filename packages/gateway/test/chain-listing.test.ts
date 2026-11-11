import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHAIN_ROOM_REFUSED_CODE, MODEL_ID_CHANGED_CODE, OUTPUT_RESERVE, ceilRatio, marginFloorFor } from '@momonga/protocol';
import type { Capabilities, ChainRoomFacts, ProviderAdapter } from '@momonga/protocol';
import { createScriptedAdapter, textResponseEvents, testKernelLock } from '@momonga/testkit';
import type { ScriptedAdapter } from '@momonga/testkit';
import { createManagedTarget, saveProbeRecord } from '../src/index.ts';
import { invalidRequest } from '../src/core/errors.ts';
import { mergeCapabilities } from '../src/core/router.ts';
import { capabilityFailingAdapter } from './capability-failing-adapter.ts';
import { FM_CURRENCY, fmRecordKey, fmTargetBase, idleServer, recordKeyOptions } from './fm-record-support.ts';
import { getJson, makeDir, postJson, readJson, startGateway, userInput } from './gateway-helpers.ts';
import { makeReport } from './report-fixture.ts';

const FIRST = 'a/first';
const SECOND = 'b/second';
const THIRD = 'c/third';

const CAPABILITIES: Capabilities = {
  contextWindow: 8192,
  maxOutputTokens: 1024,
  toolCalling: 'native',
  structuredOutput: 'json_schema',
  streaming: true,
  stopSequences: true,
  imageInput: false,
  parallelToolCalls: true,
  schemaDialect: 'json-schema-2020-12',
  tokenCounting: 'exact',
  usageReported: true,
  maxConcurrency: 4,
  source: 'declared',
};

const SMALLER: Capabilities = { ...CAPABILITIES, contextWindow: 4096, maxOutputTokens: 512, tokenCounting: 'estimated' };

const UNKNOWN_NUMBERS = { toolCalling: { state: 'unavailable', status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: 'no numbers', param: 'model' }, source: 'unprobed' };

const listed = (capabilities: Capabilities, calls = 0): ScriptedAdapter =>
  createScriptedAdapter({ calls: Array.from({ length: calls }, () => ({ events: textResponseEvents({ model: 'upstream', chunks: ['served'] }) })), capabilities });

const unavailable = (): ProviderAdapter => capabilityFailingAdapter({ inner: listed(CAPABILITIES), fails: () => invalidRequest('capabilities_unknown', 'no numbers', 'model', 412) });

const withRoom = (adapter: ScriptedAdapter, facts: ChainRoomFacts): ProviderAdapter => ({ ...adapter, roomFacts: async () => facts });

type Entry = { id: string; capabilities: Record<string, unknown>; chain: Array<{ model: string; capabilities: Record<string, unknown> }> };

const entriesOf = async (adapters: Record<string, ProviderAdapter>, chains: Record<string, string[]>) => {
  const harness = await startGateway({ adapters, config: { targets: Object.fromEntries(Object.keys(adapters).map((canon) => [canon, {}])), chains, retry: { maxAttempts: 1, totalWaitMs: 1 } } });
  const entries = (await getJson(harness.client, '/v1/momonga/models')).body.data as Entry[];
  const entryOf = (id: string): Entry => {
    const found = entries.find((entry) => entry.id === id);
    if (found === undefined) throw new Error(`the listing has no entry ${id}`);
    return found;
  };
  return { harness, entryOf };
};

describe('rule L: the state of a model decides its entry, and a fallback member never hides it (design-model-names 4.11)', () => {
  it('lists a model that is itself unavailable with that state', async () => {
    const { entryOf } = await entriesOf({ [FIRST]: unavailable(), [SECOND]: listed(CAPABILITIES) }, { [FIRST]: [FIRST, SECOND] });
    expect(entryOf(FIRST).capabilities).toEqual(UNKNOWN_NUMBERS);
  });

  it('still lists a model whose fallback member is unavailable, and shows that member with its own state', async () => {
    const { entryOf } = await entriesOf({ [FIRST]: listed(CAPABILITIES), [SECOND]: unavailable() }, { [FIRST]: [FIRST, SECOND] });
    const entry = entryOf(FIRST);
    expect(entry.capabilities).toEqual(CAPABILITIES);
    expect(entry.chain.map((member) => member.model)).toEqual([FIRST, SECOND]);
    expect(entry.chain[1]?.capabilities).toEqual(UNKNOWN_NUMBERS);
  });

  it('merges the members that are listed and leaves the unavailable one out of the fold', async () => {
    const { entryOf } = await entriesOf({ [FIRST]: listed(CAPABILITIES), [SECOND]: unavailable(), [THIRD]: listed(SMALLER) }, { [FIRST]: [FIRST, SECOND, THIRD] });
    expect(entryOf(FIRST).capabilities).toEqual(JSON.parse(JSON.stringify(mergeCapabilities([CAPABILITIES, SMALLER]))));
  });

  it('lists a model unavailable with chain_room_refused when the fold leaves no room for the input', async () => {
    const unbounded = withRoom(listed(CAPABILITIES), { outputBounded: false, contextWindow: 1000, maxOutputTokens: 990 });
    const { harness, entryOf } = await entriesOf({ [FIRST]: unbounded }, { [FIRST]: [FIRST] });
    const state = entryOf(FIRST).capabilities['toolCalling'] as Record<string, unknown>;
    expect(state).toMatchObject({ state: 'unavailable', status: 412, type: 'invalid_request', code: CHAIN_ROOM_REFUSED_CODE, param: 'model' });
    expect(state['message']).toBe(
      `first and the models it falls back to include a model that carries no output bound (outputBoundField none), so any of them can emit up to 990 tokens; with the smallest context window 1000 only ${1000 - 990 - marginFloorFor(1000)} tokens of input remain, below the ${ceilRatio(OUTPUT_RESERVE, 1000)} required`,
    );
    const refused = await readJson(await postJson(harness.client, '/v1/responses', { model: FIRST, input: userInput('hi') }));
    expect(refused.status).toBe(412);
    expect(refused.body.error).toMatchObject({ code: CHAIN_ROOM_REFUSED_CODE, param: 'model', message: state['message'] });
  });

  it('drops an unavailable fallback member from a request with no attempt, and fails with its error only when it is the last candidate', async () => {
    const first = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'first is down' } }, { failure: { status: 503, message: 'first is down' } }], capabilities: CAPABILITIES });
    const third = listed(CAPABILITIES, 1);
    const passed = await entriesOf({ [FIRST]: first, [SECOND]: unavailable(), [THIRD]: third }, { [FIRST]: [FIRST, SECOND, THIRD] });
    const served = await readJson(await postJson(passed.harness.client, '/v1/responses', { model: FIRST, input: userInput('hi') }));
    expect(served.status).toBe(200);
    expect(served.body.momonga).toMatchObject({ target: THIRD, fallbackFrom: [FIRST], attempts: 2 });

    const failing = createScriptedAdapter({ calls: [{ failure: { status: 503, message: 'first is down' } }], capabilities: CAPABILITIES });
    const last = await entriesOf({ [FIRST]: failing, [SECOND]: unavailable() }, { [FIRST]: [FIRST, SECOND] });
    const ended = await readJson(await postJson(last.harness.client, '/v1/responses', { model: FIRST, input: userInput('hi') }));
    expect(ended.status).toBe(502);
    expect(ended.body.error.message).toContain('first is down');

    const only = await entriesOf({ [FIRST]: unavailable(), [SECOND]: listed(CAPABILITIES, 1) }, { [FIRST]: [FIRST, SECOND] });
    const own = await readJson(await postJson(only.harness.client, '/v1/responses', { model: FIRST, input: userInput('hi') }));
    expect(own.status).toBe(412);
    expect(own.body.error.code).toBe('capabilities_unknown');
  });
});

describe('rule M: a managed server that lists another id than its entry is never served under the entry (design-model-names 3.7, 4.11)', () => {
  it('answers model_id_changed with the id the server lists and the id of the entry', async () => {
    const probeRecordDir = path.join(makeDir(), 'probe');
    const key = fmRecordKey('cd'.repeat(32), '25A100');
    await saveProbeRecord(probeRecordDir, key, { ...makeReport(1, 1), modelId: 'renamed-by-the-server' }, FM_CURRENCY, testKernelLock());
    const managed = await createManagedTarget({
      ...fmTargetBase('system'),
      server: idleServer,
      binary: '/opt/fake/fm',
      exec: async () => ({ exitCode: 0, stdout: '5\n', stderr: '' }),
      probeRecordDir,
      ...recordKeyOptions(key),
      toolCallingSetting: 'native',
      declaredModel: 'system',
    });
    const refusal = await managed.capabilities({ name: 'apple/system', display: 'system', model: 'system' }, undefined).then(
      () => undefined,
      (error: unknown) => error as { status: number; body: Record<string, unknown> },
    );
    expect(refusal?.status).toBe(412);
    expect(refusal?.body).toMatchObject({
      type: 'invalid_request',
      code: MODEL_ID_CHANGED_CODE,
      param: 'model',
      message: 'The server of system lists "renamed-by-the-server", not "system". Run /models add to add the model it serves now.',
    });
  });
});
