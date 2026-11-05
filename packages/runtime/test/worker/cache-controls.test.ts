import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '@momonga/foundation';
import type { CreateResponseBody, InputItem, PromptCacheCounts, RunEventPayload } from '@momonga/protocol';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { assistantMessage, callsStep, textStep } from './scripts.ts';

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

const SEEDED_HISTORY_MARK = 500;
const SEEDED_USAGE = { input_tokens: 50, output_tokens: 5, total_tokens: 55 };
const seededResponded = (step: number, output: unknown[]): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt: 1,
  response: { status: 'completed', output, usage: SEEDED_USAGE },
});
const seededRequested = (step: number): RunEventPayload => {
  const body: CachedBody = {
    model: 'fm',
    input: [{ type: 'message', role: 'user', content: 'question one' }],
    tools: [],
    tool_choice: 'auto',
    max_output_tokens: 100,
    store: false,
    stream: true,
    momonga: { cache: { stable: 1, fixed: 1, history: SEEDED_HISTORY_MARK } },
  };
  return { type: 'model.requested', step, attempt: 1, digest: sha256Hex(canonicalJson(body)), body };
};

const compactingConversation: RunEventPayload[] = [
  seededResponded(1, [{ type: 'function_call', id: 'fc_c1', call_id: 'c1', name: 'Read', arguments: '{"file_path":"/proj/big.txt"}' }]),
  { type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Read', kind: 'other', title: 'Read', rawInput: { file_path: '/proj/big.txt' } },
  { type: 'tool.completed', callId: 'c1', status: 'completed', output: 'r'.repeat(60_000), handle: 'f'.repeat(64) },
  seededResponded(2, [assistantMessage('m2', `long ${'x'.repeat(60_000)}`)]),
  { type: 'user.message', text: 'question two' },
  seededResponded(3, [assistantMessage('m3', `answer two ${'y'.repeat(60_000)}`)]),
  { type: 'user.message', text: 'question three' },
  seededRequested(4),
  seededResponded(4, [assistantMessage('m4', `answer three ${'z'.repeat(60_000)}`)]),
  { type: 'user.message', text: 'question four' },
];

describe('a compaction starts a new epoch (4.5)', () => {
  it('sends no previousHistory on the first request after context.compacted, with marks the gateway accepts', async () => {
    const env = await makeEnv({ capabilities: capabilitiesFor(40_000) });
    env.settings.contextValue = { ...env.settings.contextValue, adaptiveBudget: false, autoCompact: true };
    const run = env.enqueue('question one');
    env.seed(run.id, compactingConversation, 'release');
    env.gateway.script.push(textStep('Done.'));

    await env.runOnce(env.worker());

    expect(env.ofType(run.id, 'context.compacted')).toHaveLength(1);
    const after = sentBodies(env).at(-1)!;
    const marks = marksOf(after);
    expect(marks.previousHistory).toBeUndefined();
    expect(marks.stable).toBeLessThanOrEqual(marks.fixed);
    expect(marks.fixed).toBeLessThanOrEqual(marks.history);
    expect(marks.history).toBeLessThanOrEqual(inputOf(after).length);
  });
});

const seeded = (seed: number) => {
  let state = seed >>> 0;
  return (min: number, max: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return min + Math.floor((state / 0x100000000) * (max - min + 1));
  };
};

type Recorded = { body: CachedBody; prefix: { preservedItems: number; toolsChanged: boolean } | undefined };

const continuesEpoch = (previous: Recorded, next: Recorded): boolean =>
  next.prefix !== undefined && !next.prefix.toolsChanged && next.prefix.preservedItems >= marksOf(previous.body).history;

describe('the marks over generated request sequences (4.5; T2-5 has no formal model)', () => {
  it.for(Array.from({ length: 12 }, (_, index) => index + 1))('keep their order, and previousHistory follows the recorded prefix relation, seed %i', async (seed) => {
    const draw = seeded(seed);
    const compacting = draw(0, 1) === 1;
    const env = await makeEnv({ capabilities: capabilitiesFor(40_000) });
    env.settings.contextValue = { ...env.settings.contextValue, adaptiveBudget: false, autoCompact: true, cachePrefix: draw(0, 1) === 1 };
    env.instructions.files.set(`${env.project}/AGENTS.md`, ROOT_RULE);
    const steps = draw(0, 4);
    for (let step = 0; step < steps; step += 1) {
      env.gateway.script.push(callsStep([{ callId: `g${step}`, name: 'Echo', args: { value: 'v'.repeat(draw(1, 4000)) } }]));
    }
    env.gateway.script.push(textStep('Done.'));
    const run = env.enqueue('question one');
    if (compacting) env.seed(run.id, compactingConversation, 'release');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    const seededSteps = compacting ? 1 : 0;
    const recorded = env.ofType(run.id, 'model.requested').map((event): Recorded => ({ body: event.body as CachedBody, prefix: event.prefix }));
    expect(recorded).toHaveLength(seededSteps + steps + 1);
    recorded.slice(seededSteps).forEach((request, offset) => {
      const marks = marksOf(request.body);
      expect(marks.stable).toBeLessThanOrEqual(marks.fixed);
      expect(marks.fixed).toBeLessThanOrEqual(marks.history);
      expect(marks.history).toBeLessThanOrEqual(inputOf(request.body).length);
      const previous = recorded[seededSteps + offset - 1];
      if (previous === undefined) {
        expect(marks.previousHistory).toBeUndefined();
        return;
      }
      if (continuesEpoch(previous, request)) {
        expect(marks.previousHistory).toBe(marksOf(previous.body).history);
        expect(marks.fixed).toBeLessThanOrEqual(marks.previousHistory as number);
        expect(marks.previousHistory).toBeLessThanOrEqual(marks.history);
      } else {
        expect(marks.previousHistory).toBeUndefined();
      }
    });
  });
});

describe('previousHistory survives a new claim (4.5)', () => {
  it('reads the previous request of the run from the journal after the claim yields on a shutdown', async () => {
    const env = await envWithRootAgents(false);
    let shutdown: Promise<void> | undefined;
    const first = env.worker('worker-1');
    env.toolbox.hooks.Echo = async () => {
      shutdown = first.abort('shutdown');
    };
    echoThenDone(env);
    const run = env.enqueue('Echo then finish');

    await env.runOnce(first);
    await shutdown;
    await env.runOnce(env.worker('worker-2'));

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'run.started')).toHaveLength(2);
    const [before, after] = sentBodies(env);
    expect(env.ofType(run.id, 'model.requested')[1]?.prefix).toMatchObject({ toolsChanged: false });
    expect(marksOf(after!).previousHistory).toBe(marksOf(before!).history);
    expect(after!.prompt_cache_key).toBe(keyOf(after!, 2));
  });
});

describe.for([false, true])('a new arrival ends the epoch (4.5), cachePrefix %s', (cachePrefix) => {
  it('leaves previousHistory absent on the next request, with marks in the gateway order', async () => {
    const env = await envWithRootAgents(cachePrefix);
    env.instructions.files.set(`${env.project}/src/AGENTS.md`, 'Nested rule: name things plainly.');
    env.gateway.script.push(callsStep([{ callId: 'c1', name: 'Read', args: { file_path: `${env.project}/src/a.ts` } }]), textStep('Done.'));
    const run = env.enqueue('Read a file');

    await env.runOnce(env.worker());

    expect(env.run(run.id).status).toBe('COMPLETED');
    expect(env.ofType(run.id, 'instructions.loaded')).toHaveLength(2);
    const [first, second] = sentBodies(env);
    expect(inputOf(second!).some((item) => canonicalJson(item).includes('Nested rule'))).toBe(true);
    const marks = marksOf(second!);
    expect(marks.previousHistory).toBeUndefined();
    expect(marks.stable).toBeLessThanOrEqual(marks.fixed);
    expect(marks.fixed).toBeLessThanOrEqual(marks.history);
    expect(marks.fixed).toBeGreaterThan(marksOf(first!).fixed);
  });
});
