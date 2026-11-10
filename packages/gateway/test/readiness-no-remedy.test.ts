import { describe, expect, it } from 'vitest';
import { agentReadiness } from '@momonga/protocol';
import type { AdapterContext, AdapterRequest, Capabilities, UnavailableCapabilities } from '@momonga/protocol';
import { createFakeClock } from '@momonga/testkit';
import { UNDICI_DEFAULT_LIVENESS } from '@momonga/testkit';
import { createOpenResponsesAdapter, unauthenticatedSource } from '../src/index.ts';
import { CC_CAPABILITIES, TARGET, collect, makeAdapter, readFileTool, startFake } from './cc-support.ts';
import { START_MS, registerCleanup } from './gateway-helpers.ts';
import { REMOTE_CAPABILITIES } from './upstream-gateway-support.ts';

const SURFACE_WORDS = ['/model', 'models add', 'models detect'];

const withTools: AdapterRequest = { model: 'system', input: [{ type: 'message', role: 'user', content: 'read it' }], tools: [readFileTool] };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

describe('a refusal the gateway sends carries the message of the state and no remedy of a surface (design-model-names 2.10, A39)', () => {
  it('chat-completions refuses tools for a model that cannot call them with exactly the no_tools message', async () => {
    const fake = await startFake({ scenario: 'tools-ok', script: [] });
    const capabilities: Capabilities = { ...CC_CAPABILITIES, toolCalling: 'none' };
    const adapter = makeAdapter(fake, { capabilities: async () => capabilities }, 'none');
    const { error } = await collect(adapter, withTools);
    const readiness = agentReadiness(capabilities);
    if (readiness.state !== 'no_tools') throw new Error('a model without tool calling is not in the no_tools state');
    expect(messageOf(error)).toBe(readiness.message);
    for (const word of SURFACE_WORDS) expect(messageOf(error)).not.toContain(word);
  });

  it('open-responses refuses an unavailable model with exactly the unavailable message', async () => {
    const unavailable: UnavailableCapabilities = {
      toolCalling: { state: 'unavailable', status: 412, type: 'invalid_request', code: 'capabilities_unknown', message: 'the model gpt-5.5 cannot be used yet', param: 'model' },
      source: 'unprobed',
    };
    const adapter = createOpenResponsesAdapter({
      liveness: UNDICI_DEFAULT_LIVENESS,
      resolveEndpoint: async () => ({ kind: 'unix', socketPath: '/unused.sock' }),
      authSource: unauthenticatedSource,
      capabilities: async () => REMOTE_CAPABILITIES,
      clock: createFakeClock(START_MS),
    });
    registerCleanup(() => adapter.close());
    const ctx: AdapterContext = {
      signal: new AbortController().signal,
      target: TARGET,
      attempt: 1,
      reasoningOrigin: { own: (item) => item },
      capabilities: unavailable as unknown as Capabilities,
    };
    const error = await (async () => {
      try {
        for await (const _event of adapter.create(withTools, ctx)) void _event;
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(messageOf(error)).toBe('the model gpt-5.5 cannot be used yet');
    for (const word of SURFACE_WORDS) expect(messageOf(error)).not.toContain(word);
  });
});
