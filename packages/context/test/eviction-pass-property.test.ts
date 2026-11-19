import { describe, expect, it, vi } from 'vitest';
import { ContextOverflowError, budgetFor, buildContext, createTokenMeter } from '@momonga/context';
import type { BuiltContext, HistoryItem, MeterRequest, TokenMeter } from '@momonga/context';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import { DEFAULT_KEEP_RECENT_STEPS, DEFAULT_KEEP_RECENT_TURNS, protectionRungsOf, shapeOf } from '../src/levels.ts';
import { MODEL, argsCall, assistant, capabilitiesFor, fakeBlobs, fakeReader, inputFor, output, seeded, shapeCounter, sourcesWith, user } from './helpers.ts';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const CASES = 600;
const CAPABILITIES = capabilitiesFor(4096, { maxOutputTokens: 1024, tokenCounting: 'estimated' });
const I = budgetFor(CAPABILITIES, 0, 0).I;
const SYSTEM_PROMPT = 'S'.repeat(6000);
const ARGUMENT_SIZES = [0, 300, 500, 1000, 1600];
const SPIKE_SIZES = [2400, 3200, 4000];
const OBSERVE_SHARE = 0.5;
const GAINFUL_SIZES = [120, 400, 800];
const DUPLICATE_LETTERS = ['a', 'b'];

type Random = ReturnType<typeof seeded>;

type Sent = { tokens: number; bound: number; digest: string };

type Case = { observes: boolean[]; steps: HistoryItem[][]; texts: Map<string, string>; gainful: string[]; layout: 'cachePrefix' | undefined };

const caseOf = (random: Random): Case => {
  const steps: HistoryItem[][] = [];
  const texts = new Map<string, string>();
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
    const text = isGainful ? DUPLICATE_LETTERS[random.int(0, DUPLICATE_LETTERS.length - 1)]?.repeat(GAINFUL_SIZES[random.int(0, GAINFUL_SIZES.length - 1)] as number) as string : `ok${index}`;
    texts.set(callId, text);
    if (isGainful) gainful.push(callId);
    const sizes = index === count - 1 && random.next() < 0.4 ? SPIKE_SIZES : ARGUMENT_SIZES;
    steps.push([argsCall(seq, callId, sizes[random.int(0, sizes.length - 1)] as number), output(seq + 1, callId, text)]);
    seq += 2;
  }
  const observes = steps.map(() => random.next() < OBSERVE_SHARE);
  return { observes, steps, texts, gainful, layout: random.next() < 0.25 ? 'cachePrefix' : undefined };
};

const loadOf = (sent: Sent): number => sent.tokens + sent.bound;

type Violation = { seed: number; build: number; rule: string; detail: string };

type Branches = { keptFitting: number; keptLowered: number; refusedRestored: number; refusedOverflow: number; noPass: number; groupEvicted: number; protectedCopyBuilds: number };

const BRANCHES: Branches = { keptFitting: 0, keptLowered: 0, refusedRestored: 0, refusedOverflow: 0, noPass: 0, groupEvicted: 0, protectedCopyBuilds: 0 };

const runCase = async (seed: number): Promise<Violation[]> => {
  const scenario = caseOf(seeded(seed));
  const meter = createTokenMeter({ counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE), model: MODEL, capabilities: CAPABILITIES });
  let sent: Sent[] = [];
  const recording: TokenMeter = {
    ...meter,
    count: async (request: MeterRequest) => {
      const view = await meter.count(request);
      if (request.sent === true) sent.push({ tokens: view.inputTokens, bound: view.underAt(view.inputTokens), digest: view.inputDigest });
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
        outputFormatters: ['identicalOutput'],
        ...(scenario.layout === undefined ? {} : { layout: scenario.layout }),
      }),
      ports,
    ).then(
      (built: BuiltContext) => built,
      (error: unknown) => error,
    );
    const before = sent[0];
    if (before === undefined) throw new Error(`seed ${seed} build ${build}: no sent count`);
    const lastCounted = sent.at(-1) as Sent;
    const passRan = lastCounted.digest !== before.digest;
    const violation = (rule: string, detail: string) => violations.push({ seed, build, rule, detail });
    const fitsAt = (counted: Sent): boolean => counted.tokens + counted.bound <= I;
    if (outcome instanceof ContextOverflowError) {
      const errorLoad = outcome.inputTokens + (I - outcome.inputBudget);
      const passKept = passRan && outcome.inputTokens === lastCounted.tokens && errorLoad === loadOf(lastCounted);
      if (loadOf(before) <= I) violation('NoOverflowWhenTheUnevictedInputFits', `unevicted ${before.tokens}+${before.bound} fits, error ${outcome.inputTokens} against ${outcome.inputBudget}`);
      else if (passKept) {
        BRANCHES.keptLowered += 1;
        if (errorLoad >= loadOf(before)) violation('KeptPassLowersTheLoad', `unevicted load ${loadOf(before)}, error load ${errorLoad}`);
      } else {
        if (errorLoad !== loadOf(before)) violation('RefusedPassRestoresTheLoad', `unevicted load ${loadOf(before)}, error load ${errorLoad}`);
        if (passRan) {
          BRANCHES.refusedOverflow += 1;
          if (fitsAt(lastCounted)) violation('FittingPassRefused', `pass ${lastCounted.tokens}+${lastCounted.bound} fits`);
          if (loadOf(lastCounted) < loadOf(before)) violation('LoweringPassRefused', `pass load ${loadOf(lastCounted)}, unevicted load ${loadOf(before)}`);
        } else BRANCHES.noPass += 1;
      }
      break;
    }
    if (!(outcome instanceof Object) || !('input' in outcome)) throw outcome;
    const built = outcome as BuiltContext;
    const omitted = built.evictions.filter((eviction) => eviction.kind === 'omitted').map((eviction) => eviction.callId);
    if (passRan) {
      if (built.inputDigest === lastCounted.digest) {
        BRANCHES.keptFitting += 1;
        if (!fitsAt(lastCounted)) violation('KeptPassFits', `pass ${lastCounted.tokens}+${lastCounted.bound} kept but does not fit`);
      } else if (built.inputDigest === before.digest) {
        BRANCHES.refusedRestored += 1;
        if (fitsAt(lastCounted)) violation('FittingPassRefused', `pass ${lastCounted.tokens}+${lastCounted.bound} fits, built ${before.tokens}`);
      } else violation('BuiltIsPassOrUnevicted', `built digest matches neither`);
    } else BRANCHES.noPass += 1;
    const protectedSlots = protectionRungsOf(shapeOf(history, 0), DEFAULT_KEEP_RECENT_TURNS, DEFAULT_KEEP_RECENT_STEPS)[0]?.protectedSlots as Set<number>;
    const protectedIds = new Set(history.flatMap((entry, index) => (protectedSlots.has(index) && entry.item.type === 'function_call_output' ? [entry.item.call_id] : [])));
    const newlyOmitted = omitted.filter((callId) => !evicted.has(callId));
    for (const callId of newlyOmitted) if (protectedIds.has(callId)) violation('NoProtectedEvicted', `${callId} is protected`);
    for (const callId of omitted) evicted.add(callId);
    const referents = new Map<string, string>();
    for (const callId of scenario.gainful) {
      const text = scenario.texts.get(callId) as string;
      if (!referents.has(text)) referents.set(text, callId);
    }
    const positionOf = (callId: string): number => scenario.gainful.indexOf(referents.get(scenario.texts.get(callId) as string) as string);
    for (const callId of newlyOmitted) {
      const keepsProtectedCopy = (id: string): boolean =>
        scenario.gainful.some((other) => other !== id && scenario.texts.get(other) === scenario.texts.get(id) && !evicted.has(other));
      const skipped = scenario.gainful.slice(0, positionOf(callId)).filter((id) => !evicted.has(id) && !protectedIds.has(id) && !keepsProtectedCopy(id));
      if (skipped.length > 0) violation('OldestFirst', `${callId} evicted while ${skipped.join(', ')} stayed`);
    }
    if (omitted.some((callId) => omitted.some((other) => other !== callId && scenario.texts.get(other) === scenario.texts.get(callId)))) BRANCHES.groupEvicted += 1;
    const finalIds = new Set(built.input.flatMap((item) => (item.type === 'function_call_output' ? [item.call_id] : [])));
    for (const callId of omitted) {
      const copies = scenario.gainful.filter((id) => scenario.texts.get(id) === scenario.texts.get(callId) && finalIds.has(id));
      const referencing = built.input.filter((item) => item.type === 'function_call_output' && copies.includes(item.call_id) && !evicted.has(item.call_id));
      if (referencing.length > 0) BRANCHES.protectedCopyBuilds += 1;
    }
    if (scenario.observes[build - 1] === true) meter.observe({ inputDigest: built.inputDigest, inputTokens: built.inputTokens });
  }
  return violations;
};

describe('R1 over seeded reported histories', () => {
  it(`holds the pass rules in ${CASES} cases and reaches every branch: kept fitting, kept lowering an overflow, refused and restored, groups with protected copies`, async () => {
    const violations: Violation[] = [];
    for (let seed = 1; seed <= CASES; seed += 1) violations.push(...(await runCase(seed)));
    const byRule = Object.groupBy(violations, (violation) => violation.rule);
    expect(
      Object.fromEntries(Object.entries(byRule).map(([rule, found]) => [rule, found?.length ?? 0])),
      JSON.stringify(violations.slice(0, 3)),
    ).toEqual({});
    for (const [branch, reached] of Object.entries(BRANCHES)) expect(reached, `branch ${branch} was never reached`).toBeGreaterThan(0);
  });
});
