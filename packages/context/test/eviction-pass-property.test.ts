import { describe, expect, it } from 'vitest';
import { ContextOverflowError, budgetFor, buildContext, createTokenMeter } from '@momonga/context';
import type { BuiltContext, HistoryItem, MeterRequest, TokenMeter } from '@momonga/context';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import { MODEL, argsCall, assistant, capabilitiesFor, fakeBlobs, fakeReader, inputFor, output, seeded, shapeCounter, sourcesWith, user } from './helpers.ts';

const CASES = 600;
const CAPABILITIES = capabilitiesFor(4096, { maxOutputTokens: 1024, tokenCounting: 'estimated' });
const I = budgetFor(CAPABILITIES, 0).I;
const SYSTEM_PROMPT = 'S'.repeat(6000);
const ARGUMENT_SIZES = [0, 300, 500, 1000, 1600];
const GAINFUL_SIZES = [120, 400, 800];

type Random = ReturnType<typeof seeded>;

type Sent = { tokens: number; bound: number };

type Case = { steps: HistoryItem[][]; gainful: string[]; keepRecentTurns: number; layout: 'cachePrefix' | undefined };

const caseOf = (random: Random): Case => {
  const steps: HistoryItem[][] = [];
  const gainful: string[] = [];
  const count = random.int(5, 9);
  let seq = 1;
  for (let index = 0; index < count; index += 1) {
    if (index > 0 && random.next() < 0.15) {
      steps.push([assistant(seq, 'done'), user(seq + 1, 'next')]);
      seq += 2;
    }
    const callId = `c${index}`;
    const isGainful = random.next() < 0.5;
    const text = isGainful ? String.fromCharCode(97 + (index % 26)).repeat(GAINFUL_SIZES[random.int(0, GAINFUL_SIZES.length - 1)] as number) : 'ok';
    if (isGainful) gainful.push(callId);
    steps.push([argsCall(seq, callId, ARGUMENT_SIZES[random.int(0, ARGUMENT_SIZES.length - 1)] as number), output(seq + 1, callId, text)]);
    seq += 2;
  }
  const turns = steps.filter((step) => step[0]?.item.type === 'message').length + 1;
  return { steps, gainful, keepRecentTurns: turns > 1 || random.next() < 0.5 ? 1 : 3, layout: random.next() < 0.25 ? 'cachePrefix' : undefined };
};

const loadOf = (sent: Sent): number => sent.tokens + sent.bound;

type Violation = { seed: number; build: number; rule: string; detail: string };

const runCase = async (seed: number): Promise<Violation[]> => {
  const scenario = caseOf(seeded(seed));
  const meter = createTokenMeter({ counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE), model: MODEL, capabilities: CAPABILITIES });
  let sent: Sent[] = [];
  const recording: TokenMeter = {
    ...meter,
    count: async (request: MeterRequest) => {
      const view = await meter.count(request);
      if (request.sent === true) sent.push({ tokens: view.inputTokens, bound: view.underAt(view.inputTokens) });
      return view;
    },
  };
  const ports = { meter: recording, blobs: fakeBlobs(), instructions: fakeReader() };
  const evicted = new Set<string>();
  const violations: Violation[] = [];
  for (let build = 1; build <= scenario.steps.length; build += 1) {
    sent = [];
    const history = scenario.steps.slice(0, build).flat();
    const outcome = await buildContext(
      inputFor(CAPABILITIES, {
        sources: sourcesWith({ systemPrompt: SYSTEM_PROMPT, history }),
        level: 0,
        evicted: new Set(evicted),
        keepRecentTurns: scenario.keepRecentTurns,
        ...(scenario.layout === undefined ? {} : { layout: scenario.layout }),
      }),
      ports,
    ).then(
      (built: BuiltContext) => built,
      (error: unknown) => error,
    );
    const before = sent[0];
    if (before === undefined) throw new Error(`seed ${seed} build ${build}: no sent count`);
    const violation = (rule: string, detail: string) => violations.push({ seed, build, rule, detail });
    if (outcome instanceof ContextOverflowError) {
      const errorLoad = outcome.inputTokens + (I - outcome.inputBudget);
      const passKept = outcome.inputTokens !== before.tokens;
      if (loadOf(before) <= I) violation('NoOverflowWhenTheUnevictedInputFits', `unevicted ${before.tokens}+${before.bound} fits, error ${outcome.inputTokens} against ${outcome.inputBudget}`);
      else if (passKept && errorLoad >= loadOf(before)) violation('KeptPassLowersTheLoad', `unevicted load ${loadOf(before)}, error load ${errorLoad}`);
      else if (!passKept && errorLoad !== loadOf(before)) violation('RefusedPassRestoresTheLoad', `unevicted load ${loadOf(before)}, error load ${errorLoad}`);
      break;
    }
    if (!(outcome instanceof Object) || !('input' in outcome)) throw outcome;
    const built = outcome as BuiltContext;
    const omitted = built.evictions.filter((eviction) => eviction.kind === 'omitted').map((eviction) => eviction.callId);
    for (const callId of omitted) evicted.add(callId);
    for (const callId of omitted) {
      const older = scenario.gainful.slice(0, scenario.gainful.indexOf(callId));
      const skipped = older.filter((id) => !evicted.has(id));
      if (skipped.length > 0) violation('OldestFirst', `${callId} evicted while ${skipped.join(', ')} stayed`);
    }
    meter.observe({ inputDigest: built.inputDigest, inputTokens: built.inputTokens });
  }
  return violations;
};

describe('R1 over seeded reported histories', () => {
  it(`holds the pass rules in ${CASES} cases: no level-0 overflow when the unevicted input fits, a kept pass lowers the load, oldest first`, async () => {
    const violations: Violation[] = [];
    for (let seed = 1; seed <= CASES; seed += 1) violations.push(...(await runCase(seed)));
    const byRule = Object.groupBy(violations, (violation) => violation.rule);
    expect(
      Object.fromEntries(Object.entries(byRule).map(([rule, found]) => [rule, found?.length ?? 0])),
      JSON.stringify(violations.slice(0, 3)),
    ).toEqual({});
  }, 120_000);
});
