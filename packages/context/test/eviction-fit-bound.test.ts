import { describe, expect, it } from 'vitest';
import { budgetFor, buildContext, createTokenMeter } from '@momonga/context';
import type { BuildContextPorts, BuiltContext, HistoryItem, MeterRequest, TokenMeter } from '@momonga/context';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import type { InputItem } from '@momonga/protocol';
import { MODEL, argsCall, capabilitiesFor, fakeBlobs, fakeReader, handleOf, inputFor, output, shapeCounter, sourcesWith, tokensOfItem } from './helpers.ts';

const CAPABILITIES = capabilitiesFor(4096, { maxOutputTokens: 1024, tokenCounting: 'estimated' });
const SYSTEM_PROMPT = 'S'.repeat(6000);
const TARGET_TEXT = 'r'.repeat(120);
const TARGET_OUTPUT = output(2, 'c0', TARGET_TEXT);

const stepsWith = (argumentChars: number): HistoryItem[][] => [
  [argsCall(1, 'c0', 0), TARGET_OUTPUT],
  ...[1, 2, 3, 4].map((index) => [argsCall(2 * index + 1, `c${index}`, argumentChars), output(2 * index + 2, `c${index}`, 'ok')]),
];

type Measured = { tokens: number; known: number; uncounted: number; bound: number };

type Session = { meter: TokenMeter; ports: BuildContextPorts; counts: Map<number, Measured[]> };

const sessionOf = (): Session => {
  const meter = createTokenMeter({ counter: shapeCounter(() => ESTIMATED_ERROR_SHAPE), model: MODEL, capabilities: CAPABILITIES });
  const counts = new Map<number, Measured[]>();
  const recording: TokenMeter = {
    ...meter,
    count: async (request: MeterRequest) => {
      const view = await meter.count(request);
      const measured = { tokens: view.inputTokens, known: view.known, uncounted: view.uncounted, bound: view.underAt(view.inputTokens) };
      counts.set(request.input.length, [...(counts.get(request.input.length) ?? []), measured]);
      return view;
    },
  };
  return { meter, ports: { meter: recording, blobs: fakeBlobs(), instructions: fakeReader() }, counts };
};

const buildAt = (session: Session, history: HistoryItem[]): Promise<BuiltContext> =>
  buildContext(inputFor(CAPABILITIES, { sources: sourcesWith({ systemPrompt: SYSTEM_PROMPT, history }), level: 0 }), session.ports);

const reported = async (session: Session, history: HistoryItem[]): Promise<BuiltContext> => {
  const built = await buildAt(session, history);
  session.meter.observe({ inputDigest: built.inputDigest, inputTokens: built.inputTokens });
  return built;
};

const measure = async (meter: TokenMeter, input: InputItem[]): Promise<Measured> => {
  const view = await meter.count({ input, tools: [] });
  return { tokens: view.inputTokens, known: view.known, uncounted: view.uncounted, bound: view.underAt(view.inputTokens) };
};

const targetMarker = `[tool output omitted: ${tokensOfItem(TARGET_OUTPUT.item)} tokens; stored as ${handleOf(TARGET_TEXT)}; read it with ReadOutput]`;

const withTargetEvicted = (input: InputItem[]): InputItem[] =>
  input.map((item) => (item.type === 'function_call_output' && item.call_id === 'c0' ? { ...item, output: targetMarker } : item));

const outcomeOf = (build: Promise<BuiltContext>): Promise<{ built: BuiltContext } | { error: string }> =>
  build.then(
    (built) => ({ built }),
    (error: unknown) => ({ error: String(error) }),
  );

const I = budgetFor(CAPABILITIES, 0, 0).I;

describe('an eviction is judged by count + bound, the measure the fit test reads', () => {
  it('keeps an output inside the reported request whose eviction saves 11 tokens but widens the bound by 562, and fits at level 0', async () => {
    expect(I).toBe(2990);
    const steps = stepsWith(1000);
    const session = sessionOf();
    for (let count = 1; count <= 4; count += 1) await reported(session, steps.slice(0, count).flat());
    const history = steps.flat();
    const lastReported = await buildAt(session, steps.slice(0, 4).flat());
    expect(lastReported.inputTokens).toBe(2470);

    const fullLength = lastReported.input.length + 2;
    const outcome = await outcomeOf(buildAt(session, history));

    const kept = [...lastReported.input, ...(steps[4] as HistoryItem[]).map((entry) => entry.item as InputItem)];
    expect(kept).toHaveLength(fullLength);
    const keptMeasure = await measure(session.meter, kept);
    const evictedMeasure = await measure(session.meter, withTargetEvicted(kept));
    expect(keptMeasure).toEqual({ tokens: 2761, known: 2470, uncounted: 291, bound: 88 });
    const droppedFromReported = 2470 - 1527;
    const addedAfterBoundary = 2750 - 1527;
    expect(evictedMeasure).toEqual({
      tokens: 2750,
      known: 1527,
      uncounted: droppedFromReported + addedAfterBoundary,
      bound: Math.ceil(0.3 * droppedFromReported) + Math.ceil(0.3 * addedAfterBoundary),
    });
    expect(keptMeasure.tokens + keptMeasure.bound).toBeLessThanOrEqual(I);
    expect(evictedMeasure.tokens + evictedMeasure.bound).toBeGreaterThan(I);

    const trail = `count + bound of the assembled input during the build: ${JSON.stringify(session.counts.get(fullLength))}`;
    expect('error' in outcome ? outcome.error : 'built', trail).toBe('built');
    const built = (outcome as { built: BuiltContext }).built;
    expect(built.evictions.map((eviction) => eviction.callId)).toEqual([]);
    expect(built.input).toEqual(kept);
    expect(built.inputTokens).toBe(2761);
    expect(built.budget.I).toBe(I - 88);
  });

  it('still applies an eviction outside the reported request, which saves tokens and does not widen the bound', async () => {
    const steps = stepsWith(500);
    const session = sessionOf();
    const pinnedOnly = await reported(session, []);
    expect(pinnedOnly.inputTokens).toBe(1527);

    const built = await buildAt(session, steps.flat());

    const kept = built.input.map((item) => (item.type === 'function_call_output' && item.call_id === 'c0' ? (TARGET_OUTPUT.item as InputItem) : item));
    const keptMeasure = await measure(session.meter, kept);
    const evictedMeasure = await measure(session.meter, built.input);
    expect(evictedMeasure.tokens).toBeLessThan(keptMeasure.tokens);
    expect(evictedMeasure.bound).toBeLessThanOrEqual(keptMeasure.bound);
    expect(evictedMeasure.known).toBe(1527);
    expect(built.evictions.map((eviction) => eviction.callId)).toEqual(['c0']);
    expect(built.input).toEqual(withTargetEvicted(built.input));
    expect(built.inputTokens + evictedMeasure.bound).toBeLessThanOrEqual(I);
  });
});
