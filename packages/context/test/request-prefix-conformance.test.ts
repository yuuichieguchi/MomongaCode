import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ContextOverflowError, PinnedOverflowError, PinnedRoomError, buildContext, createTokenMeter } from '@momonga/context';
import type { BuiltContext, HistoryItem } from '@momonga/context';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import type { InputItem } from '@momonga/protocol';
import { DEFAULT_KEEP_RECENT_STEPS, protectionRungsOf, shapeOf } from '../src/levels.ts';
import { MODEL, argsCall, assistant, capabilitiesFor, fakeBlobs, fakeReader, inputFor, output, seeded, shapeCounter, sourcesWith, user } from './helpers.ts';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const specsDir = path.resolve(import.meta.dirname, '..', '..', '..', 'specs', 'tla');
const specText = fs.readFileSync(path.join(specsDir, 'RequestPrefix.tla'), 'utf8');
const mainConfig = fs.readFileSync(path.join(specsDir, 'RequestPrefix.cfg'), 'utf8');
const groupsConfig = fs.readFileSync(path.join(specsDir, 'RequestPrefix.groups.cfg'), 'utf8');

const CASES = 60;
const CAPABILITIES = capabilitiesFor(4096, { maxOutputTokens: 1024, tokenCounting: 'estimated' });
const SYSTEM_PROMPT_BASE = 2000;
const SYSTEM_PROMPT_STEP = 100;
const SYSTEM_PROMPT_STEPS = 70;
const MIN_GAINFUL = 120;
const GAINFUL_SIZES = [MIN_GAINFUL, 800, 1600, 2400];
const SMALL = 'ok';
const GAINFUL_SHARE = 0.8;
const DUPLICATE_SHARE = 0.3;
const DUPLICATE_SIZE = 1600;
const ARGUMENT_SIZES = [0, 50, 100];
const OMITTED = '[tool output omitted';
const IDENTICAL = /^\[identical to the output of call (\S+?);/;

type Scenario = { steps: HistoryItem[][]; texts: Map<string, string>; systemPrompt: string };

const scenarioOf = (seed: number): Scenario => {
  const random = seeded(seed);
  const steps: HistoryItem[][] = [];
  const texts = new Map<string, string>();
  let seq = 1;
  const count = random.int(8, 14);
  for (let index = 0; index < count; index += 1) {
    if (index > 0 && random.next() < 0.15) {
      steps.push([assistant(seq, 'done'), user(seq + 1, 'next')]);
      seq += 2;
    }
    const callId = `c${index}`;
    const gainful = random.next() < GAINFUL_SHARE;
    const duplicate = random.next() < DUPLICATE_SHARE;
    const letter = duplicate ? 'a' : String.fromCharCode('b'.charCodeAt(0) + index);
    const text = gainful ? letter.repeat(duplicate ? DUPLICATE_SIZE : (GAINFUL_SIZES[random.int(0, GAINFUL_SIZES.length - 1)] as number)) : `${SMALL}${index}`;
    texts.set(callId, text);
    steps.push([argsCall(seq, callId, ARGUMENT_SIZES[random.int(0, ARGUMENT_SIZES.length - 1)] as number), output(seq + 1, callId, text)]);
    seq += 2;
  }
  return { steps, texts, systemPrompt: 'S'.repeat(SYSTEM_PROMPT_BASE + SYSTEM_PROMPT_STEP * random.int(0, SYSTEM_PROMPT_STEPS)) };
};

type Rendering = { kind: 'full' } | { kind: 'omitted' } | { kind: 'reference'; to: string } | { kind: 'other' };

type Observed = {
  history: HistoryItem[];
  built: BuiltContext;
  texts: ReadonlyMap<string, string>;
  rendering: ReadonlyMap<string, Rendering>;
  order: readonly string[];
  protectedIds: ReadonlySet<string>;
  carried: ReadonlySet<string>;
};

const renderingOf = (item: InputItem, original: string): Rendering => {
  if (item.type !== 'function_call_output' || typeof item.output !== 'string') throw new Error('not a text output');
  if (item.output === original) return { kind: 'full' };
  if (item.output.startsWith(OMITTED)) return { kind: 'omitted' };
  const reference = IDENTICAL.exec(item.output);
  return reference === null ? { kind: 'other' } : { kind: 'reference', to: reference[1] as string };
};

const observe = (history: HistoryItem[], built: BuiltContext, texts: ReadonlyMap<string, string>, keepRecentTurns: number, carried: ReadonlySet<string>): Observed => {
  const rendering = new Map<string, Rendering>();
  const order: string[] = [];
  for (const item of built.input) {
    if (item.type !== 'function_call_output') continue;
    rendering.set(item.call_id, renderingOf(item, texts.get(item.call_id) as string));
    order.push(item.call_id);
  }
  const slots = protectionRungsOf(shapeOf(history, 0), keepRecentTurns, DEFAULT_KEEP_RECENT_STEPS)[0]?.protectedSlots as Set<number>;
  const protectedIds = new Set(history.flatMap((entry, index) => (slots.has(index) && entry.item.type === 'function_call_output' ? [entry.item.call_id] : [])));
  return { history, built, texts, rendering, order, protectedIds, carried };
};

const violations: Record<string, (seen: Observed) => string[]> = {
  NoProtectedEvicted: (seen) => [...seen.rendering].flatMap(([callId, shape]) => (shape.kind === 'omitted' && seen.protectedIds.has(callId) ? [`${callId} is protected and omitted`] : [])),

  RefNeverEvicted: (seen) =>
    seen.built.evictions.flatMap((eviction) =>
      eviction.kind === 'reference' && seen.rendering.get(eviction.callId)?.kind !== 'reference' ? [`${eviction.callId} is reported as a reference but rendered ${seen.rendering.get(eviction.callId)?.kind}`] : [],
    ),

  RefShowsFullReferent: (seen) =>
    [...seen.rendering].flatMap(([callId, shape]) => {
      if (shape.kind !== 'reference') return [];
      const referent = seen.rendering.get(shape.to);
      if (referent?.kind !== 'full') return [`${callId} refers to ${shape.to}, rendered ${referent?.kind ?? 'absent'}`];
      return seen.order.indexOf(shape.to) < seen.order.indexOf(callId) ? [] : [`${callId} refers to ${shape.to}, which does not come first`];
    }),

  OldestFirst: (seen) => {
    const copiesOf = (callId: string): string[] => seen.order.filter((other) => other !== callId && seen.texts.get(other) === seen.texts.get(callId));
    const gainful = (callId: string): boolean => (seen.texts.get(callId) as string).length >= MIN_GAINFUL;
    const omitted = seen.order.filter((callId) => seen.rendering.get(callId)?.kind === 'omitted' && !seen.carried.has(callId));
    return omitted.flatMap((callId) => {
      const position = seen.order.indexOf(callId);
      const stayed = seen.order.slice(0, position).filter((older) => {
        const shape = seen.rendering.get(older)?.kind;
        const keepsProtectedCopy = copiesOf(older).some((copy) => seen.protectedIds.has(copy) && seen.rendering.get(copy)?.kind !== 'omitted');
        return shape === 'full' && gainful(older) && !seen.protectedIds.has(older) && !keepsProtectedCopy;
      });
      return stayed.length === 0 ? [] : [`${callId} omitted while older ${stayed.join(', ')} stayed full`];
    });
  },
};

const checkedIn = (config: string): string[] => {
  const names: string[] = [];
  let section: string | undefined;
  for (const line of config.split('\n')) {
    if (/^(INVARIANTS?|PROPERTIES|PROPERTY)\b/.test(line)) {
      section = 'x';
      continue;
    }
    if (/^\S/.test(line)) section = undefined;
    if (section !== undefined && line.trim() !== '') names.push(line.trim());
  }
  return names;
};

const runAll = async (): Promise<{ found: string[]; omittedBuilds: number; referenceBuilds: number; partialBuilds: number }> => {
  const found: string[] = [];
  let omittedBuilds = 0;
  let referenceBuilds = 0;
  let partialBuilds = 0;
  for (let seed = 1; seed <= CASES; seed += 1) {
    const scenario = scenarioOf(seed);
    const meter = createTokenMeter({ counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE), model: MODEL, capabilities: CAPABILITIES });
    const ports = { meter, blobs: fakeBlobs(), instructions: fakeReader() };
    const evicted = new Set<string>();
    const carriedBuilds = [...scenario.steps.keys()].map((index) => ({ upTo: index + 1, carry: true, systemPrompt: scenario.systemPrompt }));
    const sweep = Array.from({ length: SYSTEM_PROMPT_STEPS + 1 }, (_unused, index) => ({
      upTo: scenario.steps.length,
      carry: false,
      systemPrompt: 'S'.repeat(SYSTEM_PROMPT_BASE + SYSTEM_PROMPT_STEP * index),
    }));
    for (const { upTo, carry, systemPrompt } of [...sweep, ...carriedBuilds]) {
      const history = scenario.steps.slice(0, upTo).flat();
      const built = await buildContext(
        inputFor(CAPABILITIES, { sources: sourcesWith({ systemPrompt, history }), level: 0, evicted: new Set(carry ? evicted : []), keepRecentTurns: 1, outputFormatters: ['identicalOutput'] }),
        ports,
      ).catch((error: unknown) => {
        if (error instanceof ContextOverflowError || error instanceof PinnedOverflowError || error instanceof PinnedRoomError) return undefined;
        throw error;
      });
      if (built === undefined) continue;
      const seen = observe(history, built, scenario.texts, 1, new Set(carry ? evicted : []));
      const rendered = [...seen.rendering.values()];
      if (rendered.some((shape) => shape.kind === 'omitted')) omittedBuilds += 1;
      if (rendered.some((shape) => shape.kind === 'reference')) referenceBuilds += 1;
      const stayedGainful = seen.order.some((callId) => seen.rendering.get(callId)?.kind === 'full' && !seen.protectedIds.has(callId) && (scenario.texts.get(callId) as string).length >= MIN_GAINFUL);
      if (stayedGainful && rendered.some((shape) => shape.kind === 'omitted')) partialBuilds += 1;
      for (const [name, check] of Object.entries(violations)) for (const message of check(seen)) found.push(`${name}: seed ${seed} upTo ${upTo}${carry ? '' : ` one-shot prompt ${systemPrompt.length}`}: ${message}`);
      if (carry) {
        for (const eviction of built.evictions) if (eviction.kind === 'omitted') evicted.add(eviction.callId);
        meter.observe({ inputDigest: built.inputDigest, inputTokens: built.inputTokens });
      }
    }
  }
  return { found, omittedBuilds, referenceBuilds, partialBuilds };
};

describe('buildContext conforms to the eviction and reference rules of RequestPrefix.tla', () => {
  it('has a check here for each of these rules, and the spec defines and checks each one', () => {
    const checked = new Set([...checkedIn(mainConfig), ...checkedIn(groupsConfig)]);
    for (const name of Object.keys(violations)) {
      expect(specText, name).toMatch(new RegExp(`^${name}\\b.*==`, 'm'));
      expect(checked.has(name), `${name} is checked by a configuration`).toBe(true);
    }
  });

  it(`holds every rule on the output of the real buildContext in ${CASES} seeded histories, and reaches omission and reference builds`, async () => {
    const { found, omittedBuilds, referenceBuilds, partialBuilds } = await runAll();
    expect(found.slice(0, 5)).toEqual([]);
    expect(omittedBuilds).toBeGreaterThan(0);
    expect(referenceBuilds).toBeGreaterThan(0);
    expect(partialBuilds, 'builds that evict some gainful outputs and keep another').toBeGreaterThan(0);
  });
});
