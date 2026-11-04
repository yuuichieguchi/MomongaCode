import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { CreateResponseBody, InputItem, PromptCacheCounts } from '@momonga/protocol';
import { makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';

const ROOT_RULE = 'Indent with tabs in this project.';

type CachedBody = CreateResponseBody & { momonga?: { cache?: PromptCacheCounts } };

const envWithRootAgents = async (cachePrefix: boolean): Promise<Env> => {
  const env = await makeEnv();
  env.settings.contextValue = { ...env.settings.contextValue, cachePrefix };
  env.instructions.files.set(`${env.project}/AGENTS.md`, ROOT_RULE);
  return env;
};

const inputOf = (body: CreateResponseBody): InputItem[] => {
  if (!Array.isArray(body.input)) throw new Error('the request carries no input items');
  return body.input;
};

const sentBodies = (env: Env): CachedBody[] => env.gateway.streams.map((stream) => stream.body as CachedBody);

const marksOf = (body: CachedBody): PromptCacheCounts => {
  const cache = body.momonga?.cache;
  if (cache === undefined) throw new Error('the request carries no momonga.cache marks');
  return cache;
};

const endOfStable = (body: CreateResponseBody): number => inputOf(body).findIndex((item) => canonicalJson(item).includes(ROOT_RULE)) + 1;

const keyOf = (body: CreateResponseBody, stable: number): string => sha256Hex(canonicalJson({ tools: body.tools ?? [], S: inputOf(body).slice(0, stable) }));

const echoThenDone = (env: Env): void => {
  env.gateway.script.push(callsStep([{ callId: 'c1', name: 'Echo', args: { value: 'x' } }]), textStep('Done.'));
};

describe.for([false, true])('the runtime sets the cache controls on every model request (4.5), cachePrefix %s', (cachePrefix) => {
  it('marks the end of S, the end of F and the last history item', async () => {
    const env = await envWithRootAgents(cachePrefix);
    echoThenDone(env);
    const run = env.enqueue('Echo then finish');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const [first, second] = sentBodies(env);
    expect(endOfStable(first!)).toBe(2);
    expect(inputOf(first!)).toHaveLength(3);
    expect(inputOf(second!)).toHaveLength(5);
    expect(marksOf(first!)).toEqual({ stable: 2, fixed: 2, history: 3 });
    expect(marksOf(second!)).toMatchObject({ stable: 2, fixed: 2, history: 5 });
  });

  it('marks the previous request last history item in the second request of the epoch', async () => {
    const env = await envWithRootAgents(cachePrefix);
    echoThenDone(env);
    env.enqueue('Echo then finish');

    await env.runOnce(env.worker());

    const [first, second] = sentBodies(env);
    expect(marksOf(first!).previousHistory).toBeUndefined();
    expect(marksOf(second!).previousHistory).toBe(marksOf(first!).history);
  });

  it('sends prompt_cache_key = sha256hex(canonicalJson({ tools, S })), equal across requests with the same tools and S', async () => {
    const env = await envWithRootAgents(cachePrefix);
    echoThenDone(env);
    env.enqueue('Echo then finish');

    await env.runOnce(env.worker());

    const [first, second] = sentBodies(env);
    expect(first!.prompt_cache_key).toBe(keyOf(first!, 2));
    expect(first!.prompt_cache_key).toMatch(/^[0-9a-f]{64}$/);
    expect(second!.prompt_cache_key).toBe(first!.prompt_cache_key);
  });

  it('records the controls in the journaled request body', async () => {
    const env = await envWithRootAgents(cachePrefix);
    echoThenDone(env);
    const run = env.enqueue('Echo then finish');

    await env.runOnce(env.worker());

    const requested = env.ofType(run.id, 'model.requested').map((event) => event.body as CachedBody);
    expect(requested.map(marksOf)).toHaveLength(2);
    expect(requested.map((body) => body.momonga?.cache)).toEqual(sentBodies(env).map((body) => body.momonga?.cache));
    expect(requested.map((body) => body.prompt_cache_key)).toEqual(sentBodies(env).map((body) => body.prompt_cache_key));
  });
});

describe('previousHistory survives a new claim (4.5)', () => {
  it('reads the previous request of the run from the journal after the claim yields on a mode change', async () => {
    const env = await envWithRootAgents(false);
    env.toolbox.hooks.Echo = async () => {
      const changed = env.store.setPermissionMode(env.session.id, 'plan');
      if (changed.kind !== 'ok') throw new Error(`the mode could not be changed: ${changed.kind}`);
    };
    echoThenDone(env);
    const run = env.enqueue('Echo then finish');

    await env.runOnce(env.worker());
    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'run.started')).toHaveLength(2);
    const [first, second] = sentBodies(env);
    expect(marksOf(second!).previousHistory).toBe(marksOf(first!).history);
    expect(second!.prompt_cache_key).toBe(keyOf(second!, 2));
  });
});
