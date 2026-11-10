import { describe, expect, it } from 'vitest';
import type { AnthropicApiVersion, Capabilities, ReasoningCapability, SamplingCapability, SamplingField } from '@momonga/protocol';
import { anthropicTextReply } from '@momonga/testkit';
import { postJson, readJson, userInput } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES, startAnthropicGateway } from './upstream-gateway-support.ts';

type Case = { label: string; param: SamplingField; value: number | null };

const ADAPTIVE: ReasoningCapability = { control: 'thinking', form: 'adaptive', efforts: ['low', 'medium', 'high'] };

const NONE: SamplingCapability = { accepts: 'none' };
const WITHOUT_THINKING: SamplingCapability = { accepts: 'without_thinking', topP: { min: 0.95, max: 1 } };
const FREE: SamplingCapability = { accepts: 'free' };

const TEMPERATURE: Case = { label: 'temperature 0.2', param: 'temperature', value: 0.2 };
const TOP_P_INSIDE: Case = { label: 'top_p 0.97, inside 0.95-1', param: 'top_p', value: 0.97 };
const TOP_P_OUTSIDE: Case = { label: 'top_p 0.5, outside 0.95-1', param: 'top_p', value: 0.5 };
const FREQUENCY_PENALTY: Case = { label: 'frequency_penalty 0.3', param: 'frequency_penalty', value: 0.3 };
const PRESENCE_PENALTY: Case = { label: 'presence_penalty 0.4', param: 'presence_penalty', value: 0.4 };

const EVERY_CASE = [TEMPERATURE, TOP_P_INSIDE, TOP_P_OUTSIDE, FREQUENCY_PENALTY, PRESENCE_PENALTY];
const PENALTIES = [FREQUENCY_PENALTY, PRESENCE_PENALTY];
const ANTHROPIC_WIRE_CASES = [TEMPERATURE, TOP_P_INSIDE, TOP_P_OUTSIDE];

const LEGACY: AnthropicApiVersion = '2023-06-01';

type Target = { sampling?: SamplingCapability; reasoning?: ReasoningCapability; apiVersion?: AnthropicApiVersion };

const capabilitiesOf = (target: Target): Capabilities =>
  Object.assign({}, REMOTE_CAPABILITIES, { reasoning: target.reasoning ?? ADAPTIVE }, target.sampling === undefined ? {} : { sampling: target.sampling });

type Thinking = { label: string; body: Record<string, unknown>; sentThinking: unknown };
const ON: Thinking = { label: 'thinking on', body: { reasoning: { effort: 'high' } }, sentThinking: { type: 'adaptive' } };
const OFF: Thinking = { label: 'thinking off', body: {}, sentThinking: undefined };

const sentBodies = (gateway: Awaited<ReturnType<typeof startAnthropicGateway>>): any[] =>
  gateway.fake.requests.filter((request) => request.path === '/v1/messages').map((request) => request.body);

const send = async (target: Target, thinking: Thinking, sample: Case) => {
  const gateway = await startAnthropicGateway({
    script: [anthropicTextReply(['ok'])],
    capabilities: capabilitiesOf(target),
    ...(target.apiVersion === undefined ? {} : { apiVersion: target.apiVersion }),
  });
  const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi'), ...thinking.body, [sample.param]: sample.value }));
  return { response, sent: sentBodies(gateway) };
};

const expectForwarded = async (target: Target, thinking: Thinking, sample: Case): Promise<void> => {
  const { response, sent } = await send(target, thinking, sample);
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0][sample.param]).toBe(sample.value);
  expect(sent[0].thinking).toEqual(thinking.sentThinking);
};

const expectRefused = async (target: Target, thinking: Thinking, sample: Case, ...named: string[]): Promise<void> => {
  const { response, sent } = await send(target, thinking, sample);
  expect(response.status).toBe(400);
  expect(response.body.error.type).toBe('invalid_request');
  expect(response.body.error.param).toBe(sample.param);
  expect(response.body.error.message).toContain(sample.param);
  expect(response.body.error.message).toContain('upstream-model');
  for (const fragment of named) expect(response.body.error.message).toContain(fragment);
  expect(sent).toEqual([]);
};

type Row = { declaration: string; sampling: SamplingCapability | undefined; thinking: Thinking; sample: Case; outcome: 'forwarded' | 'refused' };

const rowsFor = (declaration: string, sampling: SamplingCapability | undefined, thinking: Thinking, forwarded: readonly Case[]): Row[] =>
  EVERY_CASE.map((sample) => ({ declaration, sampling, thinking, sample, outcome: forwarded.includes(sample) ? 'forwarded' : 'refused' }));

const legacyMatrix: Row[] = [
  ...rowsFor('none', NONE, ON, []),
  ...rowsFor('none', NONE, OFF, []),
  ...rowsFor('without_thinking', WITHOUT_THINKING, ON, [TOP_P_INSIDE]),
  ...rowsFor('without_thinking', WITHOUT_THINKING, OFF, ANTHROPIC_WIRE_CASES),
  ...rowsFor('free', FREE, ON, ANTHROPIC_WIRE_CASES),
  ...rowsFor('free', FREE, OFF, ANTHROPIC_WIRE_CASES),
  ...rowsFor('nothing declared', undefined, ON, ANTHROPIC_WIRE_CASES),
  ...rowsFor('nothing declared', undefined, OFF, ANTHROPIC_WIRE_CASES),
];

describe('sampling parameters on an anthropic target with API version 2023-06-01', () => {
  it.for(legacyMatrix.map((row) => ({ ...row, name: `${row.declaration}, ${row.thinking.label}, ${row.sample.label}: ${row.outcome}` })))('$name', async (row) => {
    const target: Target = { apiVersion: LEGACY, ...(row.sampling === undefined ? {} : { sampling: row.sampling }) };
    if (row.outcome === 'refused') await expectRefused(target, row.thinking, row.sample);
    else await expectForwarded(target, row.thinking, row.sample);
  });

  it('reads the top_p range from the declaration rather than a fixed 0.95-1', async () => {
    const narrow: SamplingCapability = { accepts: 'without_thinking', topP: { min: 0.3, max: 0.6 } };
    await expectForwarded({ apiVersion: LEGACY, sampling: narrow }, ON, TOP_P_OUTSIDE);
    await expectRefused({ apiVersion: LEGACY, sampling: narrow }, ON, TOP_P_INSIDE);
  });

  it.for([0.95, 1])('forwards top_p %s with thinking on, since the declared range is inclusive', async (value) => {
    await expectForwarded({ apiVersion: LEGACY, sampling: WITHOUT_THINKING }, ON, { label: `top_p ${value}`, param: 'top_p', value });
  });

  it('refuses a penalty under every declaration, because the anthropic wire has no penalty field', async () => {
    for (const sample of PENALTIES) await expectRefused({ apiVersion: LEGACY, sampling: FREE }, OFF, sample);
  });
});

describe('a carried sampling parameter is any non-null value, the default included', () => {
  it('refuses temperature 1 under none', async () => {
    await expectRefused({ apiVersion: LEGACY, sampling: NONE }, OFF, { label: 'temperature 1', param: 'temperature', value: 1 });
  });

  it('forwards nothing and refuses nothing for temperature null under none', async () => {
    const { response, sent } = await send({ apiVersion: LEGACY, sampling: NONE }, OFF, { label: 'temperature null', param: 'temperature', value: null });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect('temperature' in sent[0]).toBe(false);
  });

  it('accepts temperature null on a target with the default API version', async () => {
    const { response, sent } = await send({}, OFF, { label: 'temperature null', param: 'temperature', value: null });
    expect(response.status).toBe(200);
    expect('temperature' in sent[0]).toBe(false);
  });
});

describe('a request carrying several sampling fields', () => {
  const sendBoth = async (target: Target, fields: Record<string, number>) => {
    const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])], capabilities: capabilitiesOf(target), apiVersion: LEGACY });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'scripted/upstream-model', input: userInput('hi'), ...fields }));
    return { response, sent: sentBodies(gateway) };
  };

  it('names the second field when only the second is refused', async () => {
    const { response, sent } = await sendBoth({ sampling: FREE }, { temperature: 0.2, frequency_penalty: 0.3 });
    expect(response.status).toBe(400);
    expect(response.body.error.param).toBe('frequency_penalty');
    expect(response.body.error.message.startsWith('frequency_penalty ')).toBe(true);
    expect(response.body.error.message).not.toContain('temperature');
    expect(sent).toEqual([]);
  });

  it('checks the fields in the order temperature, top_p, frequency_penalty, presence_penalty, whatever the body order', async () => {
    const { response } = await sendBoth({ sampling: NONE }, { presence_penalty: 0.4, top_p: 0.97, temperature: 0.2 });
    expect(response.status).toBe(400);
    expect(response.body.error.param).toBe('temperature');
    expect(response.body.error.message.startsWith('temperature ')).toBe(true);
  });
});

describe('thinking is off when the requested effort resolves to none', () => {
  it.for(['disabled', 'between_tools'] as const)('without_thinking forwards temperature when effort none is sent as the off form %s', async (off) => {
    const reasoning: ReasoningCapability = { control: 'thinking', form: 'adaptive', efforts: ['low', 'medium', 'high'], off };
    const thinkingOff: Thinking = { label: `effort none as ${off}`, body: { reasoning: { effort: 'none' } }, sentThinking: { type: off } };
    await expectForwarded({ apiVersion: LEGACY, sampling: WITHOUT_THINKING, reasoning }, thinkingOff, TEMPERATURE);
  });
});

describe('API version 2026-10-21 accepts no sampling parameter on any target', () => {
  it.for([TEMPERATURE, TOP_P_INSIDE])('refuses $label on a default target that declares nothing, naming the version', async (sample) => {
    await expectRefused({}, OFF, sample, '2026-10-21');
  });

  it('refuses temperature on an explicit 2026-10-21 target even when capabilities claim free', async () => {
    await expectRefused({ apiVersion: '2026-10-21', sampling: FREE }, OFF, TEMPERATURE, '2026-10-21');
  });
});
