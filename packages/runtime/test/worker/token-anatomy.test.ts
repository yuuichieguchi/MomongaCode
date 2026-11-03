import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import type { StreamEvent, TokenAnatomy, Usage } from '@momonga/protocol';
import type { GatewayPort } from '@momonga/runtime';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { inputTokensOf, tokensOfText } from './fake-gateway.ts';
import { textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';

const DETAILED_USAGE: Usage = {
  input_tokens: 900,
  output_tokens: 40,
  total_tokens: 940,
  input_tokens_details: { cached_tokens: 600 },
  output_tokens_details: { reasoning_tokens: 25 },
};

const BEFORE_CREATED_MS = 40;
const BEFORE_FIRST_OUTPUT_MS = 110;
const REST_OF_STREAM_MS = 250;

const isTerminal = (event: StreamEvent): boolean => event.type === 'response.completed' || event.type === 'response.incomplete';

const withExtension = (step: ScriptStep, extension: Record<string, unknown>): ScriptStep => ({
  ...step,
  events: step.events.map((event) =>
    isTerminal(event) && 'response' in event ? ({ ...event, response: { ...event.response, momonga: { alias: 'fm', target: 'primary', attempts: 1, usageSource: 'reported', ...extension } } } as StreamEvent) : event,
  ),
});

const pacedGateway = (env: Env): GatewayPort => ({
  ...env.gateway,
  stream: (body, options) => {
    const inner = env.gateway.stream(body, options);
    return (async function* () {
      let first = true;
      let output = true;
      for await (const event of inner) {
        if (first) env.clock.advance(BEFORE_CREATED_MS);
        first = false;
        if (output && event.type === 'response.output_text.delta') env.clock.advance(BEFORE_FIRST_OUTPUT_MS);
        if (event.type === 'response.output_text.delta') output = false;
        if (isTerminal(event)) env.clock.advance(REST_OF_STREAM_MS);
        yield event;
      }
    })();
  },
});

const layerSum = (anatomy: TokenAnatomy): number => {
  const { history, ...flat } = anatomy.layers;
  return Object.values(flat).reduce((sum, value) => sum + value, 0) + history.user + history.assistant + history.toolCalls + history.toolOutputs;
};

describe('every model call records what its request was made of and what it cost', () => {
  it('records on model.requested the anatomy of the very request it sends, summing to that request', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Hello.'));
    const run = env.enqueue('Say hello');

    await env.runOnce(env.worker());

    const [requested] = env.ofType(run.id, 'model.requested');
    const body = env.gateway.streams[0]!.body;
    const anatomy = (requested as { anatomy?: TokenAnatomy }).anatomy;
    expect(anatomy?.estimated).toBe(true);
    expect(anatomy?.total).toBe(inputTokensOf(body));
    expect(layerSum(anatomy as TokenAnatomy)).toBe(inputTokensOf(body));
    expect(anatomy?.tools).toEqual(Object.fromEntries((body.tools ?? []).map((tool) => [(tool as { name: string }).name, tokensOfText(canonicalJson(tool))])));
    expect(Object.keys(anatomy?.tools ?? {}).length).toBeGreaterThan(0);
    expect(anatomy?.layers.system).toBeGreaterThan(0);
    expect(anatomy?.layers.history.user).toBeGreaterThan(0);
  });

  it('records on model.responded the cached input, reasoning and cache write the provider reported, beside the totals', async () => {
    const env = await makeEnv();
    env.gateway.script.push(withExtension(textStep('Hello.', { usage: DETAILED_USAGE }), { cacheWriteInputTokens: 120 }));
    const run = env.enqueue('Say hello');

    await env.runOnce(env.worker());

    const [responded] = env.ofType(run.id, 'model.responded');
    expect(responded?.response.usage).toEqual({
      input_tokens: 900,
      output_tokens: 40,
      total_tokens: 940,
      input_tokens_details: { cached_tokens: 600 },
      output_tokens_details: { reasoning_tokens: 25 },
    });
    expect((responded?.response as { momonga?: unknown }).momonga).toEqual({ cacheWriteInputTokens: 120 });
  });

  it('records no cache write when the provider reported none', async () => {
    const env = await makeEnv();
    env.gateway.script.push(withExtension(textStep('Hello.', { usage: DETAILED_USAGE }), {}));
    const run = env.enqueue('Say hello');

    await env.runOnce(env.worker());

    const [responded] = env.ofType(run.id, 'model.responded');
    expect(responded?.response.usage.input_tokens_details).toEqual({ cached_tokens: 600 });
    const momonga = (responded?.response as { momonga?: Record<string, unknown> }).momonga;
    expect(momonga === undefined || !('cacheWriteInputTokens' in momonga)).toBe(true);
  });

  it('times the first stream event and the whole call with the injected clock, not the wall clock', async () => {
    const env = await makeEnv();
    env.gateway.script.push(textStep('Hello.', { usage: DETAILED_USAGE }));
    const run = env.enqueue('Say hello');

    await env.runOnce(env.worker('worker-1', { gateway: pacedGateway(env) }));

    const [responded] = env.ofType(run.id, 'model.responded');
    expect((responded?.response as { timing?: unknown }).timing).toEqual({
      firstEventMs: BEFORE_CREATED_MS + BEFORE_FIRST_OUTPUT_MS,
      durationMs: BEFORE_CREATED_MS + BEFORE_FIRST_OUTPUT_MS + REST_OF_STREAM_MS,
    });
  });
});
