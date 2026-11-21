import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REASONING_EFFORTS } from '@momonga/protocol';
import type { AdapterRequest, ReasoningCapability, ReasoningEffort } from '@momonga/protocol';
import { openResponsesTextReply } from '@momonga/testkit';
import { OPEN_RESPONSES_REASONING_EFFORTS, buildResponsesBody } from '../../src/adapters/open-responses/request.ts';
import { UnsupportedInputError } from '../../src/adapters/shared/failures.ts';
import { validator } from '../gateway-helpers.ts';
import { EVERY_REASONING_IS_OWN } from '../own-reasoning.ts';
import { REMOTE_CAPABILITIES, startOpenResponsesGateway, streamResponse, terminalOf } from '../upstream-gateway-support.ts';

const VENDORED_SPEC = new URL('../../../protocol/vendor/open-responses/2026-04-24/openapi.json', import.meta.url);
const MODEL_MAXIMUM = 8000;
const VISIBLE_CAP = 1000;

const requestOf = (effort: ReasoningEffort | undefined, cap: number | 'unbounded' = VISIBLE_CAP): AdapterRequest => ({
  model: 'upstream-model',
  input: [{ type: 'message', role: 'user', content: 'hello' }],
  ...(cap === 'unbounded' ? {} : { max_output_tokens: cap }),
  ...(effort === undefined ? {} : { reasoning_effort: effort }),
});

const bodyOf = (reasoning: ReasoningCapability | undefined, effort: ReasoningEffort | undefined, cap?: number) =>
  buildResponsesBody(requestOf(effort, cap), EVERY_REASONING_IS_OWN, { output: { maxOutputTokens: MODEL_MAXIMUM, reasoning } });

const expectSpecValid = (body: Record<string, unknown>): void => {
  expect(validator.validate('CreateResponseBody', body).errors).toEqual([]);
};

describe('open-responses request: the reasoning capability', () => {
  it('names exactly the efforts the vendored Open Responses schema accepts', () => {
    const spec = JSON.parse(fs.readFileSync(VENDORED_SPEC, 'utf8'));
    expect([...OPEN_RESPONSES_REASONING_EFFORTS]).toEqual(spec.components.schemas.ReasoningEffortEnum.enum);
  });

  describe('control reasoning_effort', () => {
    it.for(REASONING_EFFORTS.map((effort) => [effort] as const))('renders the effort %s in the reasoning field as a value the schema accepts, with the visible cap unchanged', ([effort]) => {
      const body = bodyOf({ control: 'reasoning_effort', lowest: 'none' }, effort);
      const expected = effort === 'minimal' ? 'low' : effort === 'max' ? 'xhigh' : effort;
      expect(body.reasoning).toEqual({ effort: expected });
      expect(body.max_output_tokens).toBe(VISIBLE_CAP);
      expectSpecValid(body);
    });

    it('raises a requested effort below the lowest the target accepts', () => {
      expect(bodyOf({ control: 'reasoning_effort', lowest: 'medium' }, 'none').reasoning).toEqual({ effort: 'medium' });
      expect(bodyOf({ control: 'reasoning_effort', lowest: 'medium' }, 'low').reasoning).toEqual({ effort: 'medium' });
      expect(bodyOf({ control: 'reasoning_effort', lowest: 'medium' }, 'xhigh').reasoning).toEqual({ effort: 'xhigh' });
    });

    it('sends no reasoning field when the request names no effort', () => {
      const body = bodyOf({ control: 'reasoning_effort', lowest: 'low' }, undefined);
      expect(body).not.toHaveProperty('reasoning');
      expect(body.max_output_tokens).toBe(VISIBLE_CAP);
    });
  });

  describe('control none', () => {
    it('sends no reasoning field and adds the declared headroom to the visible cap', () => {
      const body = bodyOf({ control: 'none', headroomTokens: 2000 }, 'high');
      expect(body).not.toHaveProperty('reasoning');
      expect(body.max_output_tokens).toBe(VISIBLE_CAP + 2000);
      expectSpecValid(body);
    });

    it('never raises the bound above the maximum of the model', () => {
      expect(bodyOf({ control: 'none', headroomTokens: 2000 }, 'high', 7000).max_output_tokens).toBe(MODEL_MAXIMUM);
    });

    it('adds no headroom when the request names no effort, and none when the target declares none', () => {
      expect(bodyOf({ control: 'none', headroomTokens: 2000 }, undefined).max_output_tokens).toBe(VISIBLE_CAP);
      expect(bodyOf({ control: 'none' }, 'high').max_output_tokens).toBe(VISIBLE_CAP);
    });

    it('sends no output bound when the request has none', () => {
      const body = buildResponsesBody(requestOf('high', 'unbounded'), EVERY_REASONING_IS_OWN, { output: { maxOutputTokens: MODEL_MAXIMUM, reasoning: { control: 'none', headroomTokens: 2000 } } });
      expect(body).not.toHaveProperty('max_output_tokens');
    });
  });

  describe('control thinking', () => {
    it.for([
      ['adaptive', { control: 'thinking', form: 'adaptive', efforts: ['low', 'high'] }],
      ['budget', { control: 'thinking', form: 'budget', budgets: { low: 1024 } }],
    ] as const)('refuses a request that names an effort on a target that declares the %s thinking form, with a typed reason', ([, reasoning]) => {
      let refusal: unknown;
      try {
        bodyOf(reasoning, 'low');
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(UnsupportedInputError);
      expect(refusal).toMatchObject({ code: 'unsupported_input', param: 'reasoning_effort' });
      expect((refusal as Error).message).toContain('capabilities.reasoning');
    });

    it('renders a request that names no effort', () => {
      const body = bodyOf({ control: 'thinking', form: 'adaptive', efforts: ['low', 'high'] }, undefined);
      expect(body).not.toHaveProperty('reasoning');
      expect(body.max_output_tokens).toBe(VISIBLE_CAP);
    });
  });

  it('sends no reasoning field and the requested bound for a target that declares no reasoning capability', () => {
    const body = bodyOf(undefined, 'high');
    expect(body).not.toHaveProperty('reasoning');
    expect(body.max_output_tokens).toBe(VISIBLE_CAP);
  });
});

describe('open-responses adapter through the gateway: the reasoning capability reaches the wire', () => {
  it('sends the effort of a reasoning_effort target', async () => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesTextReply(['ok'])], capabilities: { ...REMOTE_CAPABILITIES, reasoning: { control: 'reasoning_effort', lowest: 'low' } } });
    expect(terminalOf(await streamResponse(gateway, { reasoning: { effort: 'high' }, max_output_tokens: 500 })).type).toBe('response.completed');
    expect(gateway.fake.requests[0]?.body).toMatchObject({ reasoning: { effort: 'high' }, max_output_tokens: 500 });
  });

  it('sends the visible cap plus the headroom of a target without a reasoning control', async () => {
    const gateway = await startOpenResponsesGateway({ script: [openResponsesTextReply(['ok'])], capabilities: { ...REMOTE_CAPABILITIES, reasoning: { control: 'none', headroomTokens: 300 } } });
    expect(terminalOf(await streamResponse(gateway, { reasoning: { effort: 'high' }, max_output_tokens: 500 })).type).toBe('response.completed');
    const body = gateway.fake.requests[0]?.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('reasoning');
    expect(body['max_output_tokens']).toBe(800);
  });
});
