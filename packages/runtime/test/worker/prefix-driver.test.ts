import { describe, expect, it } from 'vitest';
import { GatewayRequestError } from '@momonga/runtime';
import { canonicalJson } from '@momonga/foundation';
import type { InputItem, RunEvent } from '@momonga/protocol';
import { defineTool } from '@momonga/tools';
import type { AnyTool } from '@momonga/tools';
import { capabilitiesFor, makeEnv } from './harness.ts';
import type { Env } from './harness.ts';
import { callsStep, textStep } from './scripts.ts';
import type { ScriptStep } from './fake-gateway.ts';
import { WITHIN_TURN_PROMPT, bigTool } from './within-turn-support.ts';

const SEEDS = Array.from({ length: 16 }, (_, index) => 7919 * (index + 1));

const GREP_RAW = [
  "src/app/main.ts:3:import { load } from './load';",
  ...Array.from({ length: 40 }, (_unused, index) => `src/app/main.ts:${10 + index}:  return null;`),
  'test/main.test.ts:5:  return null;',
].join('\n');

const grepTool = defineTool<Record<string, unknown>>({
  name: 'Grep',
  description: 'Search file contents',
  kind: 'search',
  sideEffect: 'read_only',
  subjectKind: 'none',
  inputSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'], additionalProperties: false },
  timeoutMs: 60_000,
  title: () => 'Grep',
  subject: () => ({ kind: 'none', tool: 'Grep' }),
  execute: async () => ({ status: 'completed', output: GREP_RAW }),
});

const seeded = (seed: number) => {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  return { int: (min: number, max: number): number => min + Math.floor(next() * (max - min + 1)) };
};

type Plan = { script: ScriptStep[]; maxSteps: number | undefined; summaries: string[]; description: string[] };

const planOf = (seed: number): Plan => {
  const random = seeded(seed);
  const script: ScriptStep[] = [];
  const description: string[] = [];
  const calls = random.int(4, 12);
  let steps = calls;
  for (let index = 0; index < calls; index += 1) {
    if (random.int(0, 5) === 0) {
      script.push({ events: [], error: new GatewayRequestError({ status: 503, type: 'server_error', code: 'gateway_closed', message: 'the gateway is shutting down' }) });
      description.push('requeue');
    }
    const kind = random.int(0, 5);
    if (kind === 5) {
      const size = random.int(200, 1600);
      script.push(
        callsStep([
          { callId: `par-g-${index}`, name: 'Grep', args: { pattern: 'null' } },
          { callId: `par-b-${index}`, name: 'Big', args: { letter: 'q', size, pad: '' } },
        ]),
      );
      description.push(`parallel grep and big ${size}`);
    } else if (kind === 4) {
      const pad = random.int(600, 1400);
      script.push(callsStep([{ callId: `pad-${index}`, name: 'Big', args: { letter: 'p', size: 0, pad: String(index).padEnd(pad, 'p') } }]));
      description.push(`padded call ${pad}`);
    } else if (kind === 0) {
      const size = random.int(200, 2400);
      script.push(callsStep([{ callId: `big-${index}`, name: 'Big', args: { letter: 'abcdef'[random.int(0, 5)] as string, size, pad: '' } }]));
      description.push(`big ${size}`);
    } else if (kind === 1) {
      script.push(callsStep([{ callId: `grep-${index}`, name: 'Grep', args: { pattern: 'null' } }]));
      description.push('grep');
    } else if (kind === 2) {
      const repeats = random.int(2, 4);
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        script.push(callsStep([{ callId: `echo-${index}-${repeat}`, name: 'Echo', args: { value: 'again' } }]));
      }
      steps += repeats - 1;
      description.push(`echo again x${repeats}`);
    } else {
      script.push(callsStep([{ callId: `echo-${index}`, name: 'Echo', args: { value: `v${index}` } }]));
      description.push('echo distinct');
    }
  }
  const wrapUp = random.int(0, 2) === 0;
  script.push(textStep(wrapUp ? 'Summary.' : 'done'));
  description.push(wrapUp ? `wrap-up after ${steps} steps` : 'done');
  return { script, maxSteps: wrapUp ? steps : undefined, summaries: ['S1', 'S2', 'S3', 'S4'], description };
};

type Body = { input?: unknown; tools?: unknown; tool_choice?: unknown; momonga?: { cache?: { stable?: number; fixed?: number; history?: number } } };

const inputOf = (body: Body): InputItem[] => {
  if (!Array.isArray(body.input)) throw new Error('a recorded request carries no input array');
  return body.input as InputItem[];
};

const commonPrefix = (left: readonly InputItem[], right: readonly InputItem[]): number => {
  let shared = 0;
  while (shared < left.length && shared < right.length && canonicalJson(left[shared]) === canonicalJson(right[shared])) shared += 1;
  return shared;
};

const namedEventsBetween = (events: readonly RunEvent[], from: number, to: number, later: Body): string[] => {
  const named = new Set<string>();
  for (const event of events) {
    if (event.seq <= from || event.seq >= to) continue;
    if (event.type === 'run.started') named.add('claim');
    if (event.type === 'context.compacted') named.add('compaction');
    if (event.type === 'context.compaction_rejected') named.add('compaction_rejected');
    if (event.type === 'context.truncated' && event.kind === 'omitted') named.add('eviction');
    if (event.type === 'context.governing_loaded') named.add('governing_changed');
    if (event.type === 'instructions.loaded') named.add('instructions');
    if (event.type === 'skill.activated') named.add('skill_activated');
    if (event.type === 'tool.loaded') named.add('tools_loaded');
  }
  if (later.tool_choice === 'none') named.add('wrap_up');
  return [...named].sort();
};

const preservedBy = (name: string, earlier: Body, evictedCalls: ReadonlySet<string>): number => {
  const cache = earlier.momonga?.cache;
  if (cache?.history === undefined || cache.fixed === undefined) throw new Error('a recorded request carries no cache marks');
  if (name === 'claim' || name === 'wrap_up' || name === 'tools_loaded') return 0;
  if (name === 'compaction' || name === 'compaction_rejected') return cache.fixed;
  if (name === 'eviction') {
    const at = inputOf(earlier).findIndex((item) => item.type === 'function_call_output' && evictedCalls.has(item.call_id));
    return at < 0 ? cache.history : at;
  }
  throw new Error(`the driver generates no ${name} event`);
};

type Violation = { pair: number; message: string };

const violationsOf = (env: Env, runId: string): Violation[] => {
  const events = env.events(runId);
  const requests = events.filter((event): event is Extract<RunEvent, { type: 'model.requested' }> => event.type === 'model.requested');
  const violations: Violation[] = [];
  for (const notice of events) {
    if (notice.type === 'notice' && notice.code === 'prefix_unexplained') violations.push({ pair: -1, message: notice.message });
  }
  for (let index = 1; index < requests.length; index += 1) {
    const earlier = requests[index - 1] as Extract<RunEvent, { type: 'model.requested' }>;
    const later = requests[index] as Extract<RunEvent, { type: 'model.requested' }>;
    const earlierBody = earlier.body as Body;
    const laterBody = later.body as Body;
    const named = namedEventsBetween(events, earlier.seq, later.seq, laterBody);
    const evictedCalls = new Set(
      events.flatMap((event) => (event.seq > earlier.seq && event.seq < later.seq && event.type === 'context.truncated' && event.kind === 'omitted' ? [event.callId] : [])),
    );
    const cache = earlierBody.momonga?.cache;
    if (cache?.history === undefined) throw new Error('a recorded request carries no history mark');
    const k = named.length === 0 ? cache.history : Math.min(...named.map((name) => preservedBy(name, earlierBody, evictedCalls)));
    const toolsEqual = canonicalJson(earlierBody.tools ?? []) === canonicalJson(laterBody.tools ?? []);
    const shared = toolsEqual ? commonPrefix(inputOf(earlierBody), inputOf(laterBody)) : 0;
    if (shared < k) violations.push({ pair: index, message: `request ${index + 1} keeps ${shared} leading items, fewer than k = ${k} for [${named.join(', ')}]` });
    const toolsChanging = named.some((name) => name === 'claim' || name === 'wrap_up' || name === 'tools_loaded');
    if (!toolsChanging && !toolsEqual) {
      violations.push({ pair: index, message: `request ${index + 1} changes the tools with no tools-changing event among [${named.join(', ')}]` });
    }
    if (later.prefix?.preservedItems !== shared) {
      violations.push({ pair: index, message: `request ${index + 1} records ${String(later.prefix?.preservedItems)} preserved items, but keeps ${shared}` });
    }
  }
  return violations;
};

const TERMINAL = new Set(['COMPLETED', 'FAILED', 'STOPPED', 'CANCELLED']);

const drive = async (seed: number) => {
  const plan = planOf(seed);
  const env = await makeEnv({ capabilities: capabilitiesFor(4000), mode: 'bypassPermissions' });
  env.settings.contextValue = {
    ...env.settings.contextValue,
    cachePrefix: true,
    observedCapacity: true,
    loopGuidance: true,
    outputFormatters: ['grep', 'log', 'json', 'identicalOutput'],
  };
  env.gateway.script.push(...plan.script);
  env.gateway.compactSummaries.push(...plan.summaries);
  const run = env.enqueue('Drive the context', plan.maxSteps === undefined ? {} : { limits: { maxSteps: plan.maxSteps } });
  const tools = (): AnyTool[] => [bigTool(), grepTool, ...env.toolbox.tools().filter((tool) => tool.name === 'Echo')];
  for (let claim = 0; claim < 12 && !TERMINAL.has(env.run(run.id).status); claim += 1) {
    const current = env.run(run.id);
    if (current.availableAt !== null && current.availableAt > env.clock.now()) env.clock.set(current.availableAt);
    await env.runOnce(env.worker(`worker-${claim}`, { toolList: tools, systemPrompt: () => WITHIN_TURN_PROMPT }));
  }
  return { env, run, plan };
};

const featuresOf = (env: Env, runId: string): string[] => {
  const seen = new Set<string>();
  for (const event of env.events(runId)) {
    if (event.type === 'context.truncated') seen.add(`truncated:${event.kind}`);
    if (event.type === 'context.compacted') seen.add('compacted');
    if (event.type === 'loop.warned') seen.add('loop.warned');
    if (event.type === 'tool.completed' && typeof event.handle === 'string' && event.output.startsWith('[formatted by')) seen.add('formatted');
    if (event.type === 'model.requested' && (event.body as Body).tool_choice === 'none') seen.add('wrap_up');
  }
  if (env.ofType(runId, 'run.started').length > 1) seen.add('claim');
  return [...seen];
};

type Outcome = { description: string[]; requests: number; violations: Violation[]; status: string; features: string[] };

const outcomes = new Map<number, Promise<Outcome>>();

const outcomeOf = (seed: number): Promise<Outcome> => {
  const known = outcomes.get(seed);
  if (known !== undefined) return known;
  const observed = drive(seed).then(({ env, run, plan }) => ({
    description: plan.description,
    requests: env.ofType(run.id, 'model.requested').length,
    violations: violationsOf(env, run.id),
    status: env.run(run.id).status,
    features: featuresOf(env, run.id),
  }));
  outcomes.set(seed, observed);
  return observed;
};

describe('random driver: the prefix rule of section 1 holds for every pair of consecutive requests built by buildNext (T2-1; review C-3)', () => {
  it.for(SEEDS)('seed %i: k is the minimum over the named events recorded, and no prefix_unexplained is raised', async (seed) => {
    const { description, requests, violations, status } = await outcomeOf(seed);

    expect(requests, `seed ${seed}: ${description.join(', ')}`).toBeGreaterThan(1);
    expect(violations, `seed ${seed}: ${description.join(', ')}; status ${status}`).toEqual([]);
  });

  it('exercises evictions, compactions, references, C1 formatting, loop warnings, claims and wrap-ups across the seeds', async () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) for (const feature of (await outcomeOf(seed)).features) seen.add(feature);

    expect([...seen].sort()).toEqual(expect.arrayContaining(['claim', 'compacted', 'formatted', 'loop.warned', 'truncated:omitted', 'truncated:reference', 'wrap_up']));
  });
});
