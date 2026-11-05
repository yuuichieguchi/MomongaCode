import { describe, expect, it } from 'vitest';
import type { Capabilities, ReasoningCapability } from '@momonga/protocol';
import { anthropicTextReply, openResponsesTextReply } from '@momonga/testkit';
import { postJson, readJson, userInput } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES, startAnthropicGateway, startOpenResponsesGateway } from './upstream-gateway-support.ts';

type SamplingDeclaration =
  | { accepts: 'none' }
  | { accepts: 'without_thinking'; topP: { min: number; max: number } }
  | { accepts: 'free' };

type SamplingParam = 'temperature' | 'top_p' | 'top_k';

type Case = { label: string; param: SamplingParam; value: number };

const ADAPTIVE: ReasoningCapability = { control: 'thinking', form: 'adaptive', efforts: ['low', 'medium', 'high'] };

const NONE: SamplingDeclaration = { accepts: 'none' };
const WITHOUT_THINKING: SamplingDeclaration = { accepts: 'without_thinking', topP: { min: 0.95, max: 1 } };
const FREE: SamplingDeclaration = { accepts: 'free' };

const TEMPERATURE: Case = { label: 'temperature 0.2', param: 'temperature', value: 0.2 };
const TOP_P_INSIDE: Case = { label: 'top_p 0.97, inside 0.95-1', param: 'top_p', value: 0.97 };
const TOP_P_OUTSIDE: Case = { label: 'top_p 0.5, outside 0.95-1', param: 'top_p', value: 0.5 };
const TOP_K: Case = { label: 'top_k 40', param: 'top_k', value: 40 };

const EVERY_CASE = [TEMPERATURE, TOP_P_INSIDE, TOP_P_OUTSIDE, TOP_K];

const capabilitiesWith = (sampling: SamplingDeclaration | undefined): Capabilities =>
  Object.assign({}, REMOTE_CAPABILITIES, { reasoning: ADAPTIVE }, sampling === undefined ? {} : { sampling });

type Thinking = { label: string; body: Record<string, unknown> };
const ON: Thinking = { label: 'thinking on', body: { reasoning: { effort: 'high' } } };
const OFF: Thinking = { label: 'thinking off', body: {} };

const sentBodies = (gateway: Awaited<ReturnType<typeof startAnthropicGateway>>): any[] =>
  gateway.fake.requests.filter((request) => request.path === '/v1/messages').map((request) => request.body);

const send = async (sampling: SamplingDeclaration | undefined, thinking: Thinking, sample: Case) => {
  const gateway = await startAnthropicGateway({ script: [anthropicTextReply(['ok'])], capabilities: capabilitiesWith(sampling) });
  const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'fast', input: userInput('hi'), ...thinking.body, [sample.param]: sample.value }));
  return { response, sent: sentBodies(gateway) };
};

const expectForwarded = async (sampling: SamplingDeclaration | undefined, thinking: Thinking, sample: Case): Promise<void> => {
  const { response, sent } = await send(sampling, thinking, sample);
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0][sample.param]).toBe(sample.value);
  if (thinking === ON) expect(sent[0].thinking).toEqual({ type: 'adaptive' });
  else expect(sent[0].thinking).toBeUndefined();
};

const expectRefused = async (sampling: SamplingDeclaration, thinking: Thinking, sample: Case): Promise<void> => {
  const { response, sent } = await send(sampling, thinking, sample);
  expect(response.status).toBe(400);
  expect(response.body.error.type).toBe('invalid_request');
  expect(response.body.error.param).toBe(sample.param);
  expect(response.body.error.message).toContain(sample.param);
  expect(response.body.error.message).toContain('remote');
  expect(sent).toEqual([]);
};

type Row = { declaration: string; sampling: SamplingDeclaration; thinking: Thinking; sample: Case; outcome: 'forwarded' | 'refused' };

const matrix: Row[] = [
  ...[ON, OFF].flatMap((thinking) => EVERY_CASE.map((sample): Row => ({ declaration: 'none', sampling: NONE, thinking, sample, outcome: 'refused' }))),
  { declaration: 'without_thinking', sampling: WITHOUT_THINKING, thinking: ON, sample: TEMPERATURE, outcome: 'refused' },
  { declaration: 'without_thinking', sampling: WITHOUT_THINKING, thinking: ON, sample: TOP_P_INSIDE, outcome: 'forwarded' },
  { declaration: 'without_thinking', sampling: WITHOUT_THINKING, thinking: ON, sample: TOP_P_OUTSIDE, outcome: 'refused' },
  { declaration: 'without_thinking', sampling: WITHOUT_THINKING, thinking: ON, sample: TOP_K, outcome: 'refused' },
  ...EVERY_CASE.map((sample): Row => ({ declaration: 'without_thinking', sampling: WITHOUT_THINKING, thinking: OFF, sample, outcome: 'forwarded' })),
  ...[ON, OFF].flatMap((thinking) => EVERY_CASE.map((sample): Row => ({ declaration: 'free', sampling: FREE, thinking, sample, outcome: 'forwarded' }))),
];

describe('sampling parameters against the declared sampling acceptance of an anthropic target', () => {
  it.for(matrix.map((row) => ({ ...row, name: `${row.declaration}, ${row.thinking.label}, ${row.sample.label}: ${row.outcome}` })))('$name', async (row) => {
    if (row.outcome === 'refused') await expectRefused(row.sampling, row.thinking, row.sample);
    else await expectForwarded(row.sampling, row.thinking, row.sample);
  });

  it('reads the top_p range from the declaration rather than a fixed 0.95-1', async () => {
    const narrow: SamplingDeclaration = { accepts: 'without_thinking', topP: { min: 0.3, max: 0.6 } };
    await expectForwarded(narrow, ON, TOP_P_OUTSIDE);
    await expectRefused(narrow, ON, TOP_P_INSIDE);
  });
});

describe('sampling parameters on an anthropic target that declares no sampling acceptance', () => {
  it.for([ON, OFF].flatMap((thinking) => EVERY_CASE.map((sample) => ({ thinking, sample, name: `${thinking.label}, ${sample.label}` }))))(
    'forwards $name unchanged',
    async ({ thinking, sample }) => {
      await expectForwarded(undefined, thinking, sample);
    },
  );
});

describe('sampling acceptance is one mechanism for every adapter that renders sampling parameters', () => {
  it('refuses temperature on an open-responses target that declares none, naming the parameter and the target', async () => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesTextReply(['ok'])], capabilities: Object.assign({}, REMOTE_CAPABILITIES, { sampling: NONE }) });
    const response = await readJson(await postJson(gateway.client, '/v1/responses', { model: 'fast', input: userInput('hi'), temperature: 0.2 }));
    expect(response.status).toBe(400);
    expect(response.body.error.param).toBe('temperature');
    expect(response.body.error.message).toContain('remote');
    expect(gateway.fake.requests).toEqual([]);
  });
});
