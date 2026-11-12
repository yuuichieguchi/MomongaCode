import { describe, expect, it } from 'vitest';
import { ContextOverflowError, budgetFor, buildContext, createTokenMeter } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, BuiltContext, HistoryItem, MeterRequest, TokenCounter, TokenMeter } from '@momonga/context';
import { ESTIMATED_ERROR_SHAPE } from '@momonga/protocol';
import type { Capabilities, InputItem } from '@momonga/protocol';
import { MODEL, argsCall, assistant, capabilitiesFor, fakeBlobs, fakeCounter, fakeReader, handleOf, inputFor, output, shapeCounter, sourcesWith, tokensOfItem, user, withTurnsBeforeCurrent } from './helpers.ts';

const ESTIMATED = capabilitiesFor(4096, { maxOutputTokens: 1024, tokenCounting: 'estimated' });
const EXACT = capabilitiesFor(4096, { maxOutputTokens: 1024, tokenCounting: 'exact' });
const SYSTEM_PROMPT = 'S'.repeat(6000);
const I = budgetFor(ESTIMATED, 0).I;

type Measured = { tokens: number; known: number; uncounted: number; bound: number };

type Session = {
  capabilities: Capabilities;
  meter: TokenMeter;
  ports: BuildContextPorts;
  sentCounts: Measured[][];
};

const measuredOf = async (meter: TokenMeter, request: MeterRequest): Promise<Measured> => {
  const view = await meter.count(request);
  return { tokens: view.inputTokens, known: view.known, uncounted: view.uncounted, bound: view.underAt(view.inputTokens) };
};

const sessionOf = (capabilities: Capabilities = ESTIMATED, counter: TokenCounter = shapeCounter(() => ESTIMATED_ERROR_SHAPE)): Session => {
  const meter = createTokenMeter({ counter, model: MODEL, capabilities });
  const sentCounts: Measured[][] = [];
  const recording: TokenMeter = {
    ...meter,
    count: async (request: MeterRequest) => {
      const view = await meter.count(request);
      if (request.sent === true) sentCounts.at(-1)?.push({ tokens: view.inputTokens, known: view.known, uncounted: view.uncounted, bound: view.underAt(view.inputTokens) });
      return view;
    },
  };
  return { capabilities, meter, ports: { meter: recording, blobs: fakeBlobs(), instructions: fakeReader() }, sentCounts };
};

const buildAt = (session: Session, history: HistoryItem[], overrides: Partial<BuildContextInput> = {}): Promise<BuiltContext> => {
  session.sentCounts.push([]);
  return buildContext(
    inputFor(session.capabilities, { sources: sourcesWith({ systemPrompt: SYSTEM_PROMPT, history }), level: 0, ...overrides }),
    session.ports,
  );
};

const reported = async (session: Session, history: HistoryItem[], overrides: Partial<BuildContextInput> = {}): Promise<BuiltContext> => {
  const built = await buildAt(session, history, overrides);
  session.meter.observe({ inputDigest: built.inputDigest, inputTokens: built.inputTokens });
  return built;
};

const measure = (meter: TokenMeter, input: InputItem[]): Promise<Measured> => measuredOf(meter, { input, tools: [] });

const loadOf = (measured: Measured): number => measured.tokens + measured.bound;

const textOfOutput = (entry: HistoryItem): string => {
  if (entry.item.type !== 'function_call_output' || typeof entry.item.output !== 'string') throw new Error('not a text output');
  return entry.item.output;
};

const markerOf = (entry: HistoryItem): string =>
  `[tool output omitted: ${tokensOfItem(entry.item as InputItem)} tokens; stored as ${handleOf(textOfOutput(entry))}; read it with ReadOutput]`;

const withEvicted = (input: InputItem[], entries: readonly HistoryItem[]): InputItem[] => {
  const markers = new Map(entries.map((entry) => [(entry.item as { call_id: string }).call_id, markerOf(entry)]));
  return input.map((item) => {
    if (item.type !== 'function_call_output') return item;
    const marker = markers.get(item.call_id);
    return marker === undefined ? item : { ...item, output: marker };
  });
};

const itemsOf = (entries: readonly HistoryItem[]): InputItem[] => entries.map((entry) => entry.item as InputItem);

const omittedIds = (built: { evictions: readonly { callId: string; kind: string }[] }): string[] =>
  built.evictions.filter((eviction) => eviction.kind === 'omitted').map((eviction) => eviction.callId);

const overflowOf = async (build: Promise<BuiltContext>): Promise<ContextOverflowError> => {
  const error = await build.then(
    (built) => built,
    (caught: unknown) => caught,
  );
  if (!(error instanceof ContextOverflowError)) throw new Error(`expected a ContextOverflowError, received ${error instanceof Error ? String(error) : `a build with ${JSON.stringify(omittedIds(error as BuiltContext))} evicted`}`);
  return error;
};

const builtOf = async (build: Promise<BuiltContext>, trail: () => string): Promise<BuiltContext> => {
  const outcome = await build.then(
    (built) => built,
    (caught: unknown) => caught,
  );
  if (outcome instanceof Error) throw new Error(`expected a build, received ${String(outcome)}; ${trail()}`);
  return outcome as BuiltContext;
};

const NEXT_TURN: HistoryItem[] = withTurnsBeforeCurrent([assistant(9, 'done'), user(10, 'next')]);

const passSteps: HistoryItem[][] = [
  [argsCall(1, 'c0', 0), output(2, 'c0', 'r'.repeat(120))],
  [argsCall(3, 'c1', 0), output(4, 'c1', 'b'.repeat(800))],
  [argsCall(5, 'c2', 0), output(6, 'c2', 'c'.repeat(800))],
  [argsCall(7, 'c3', 1800), output(8, 'c3', 'ok')],
];

const passMembers = [passSteps[0]?.[1], passSteps[1]?.[1], passSteps[2]?.[1]] as HistoryItem[];

const passFixture = async (overrides: Partial<BuildContextInput>) => {
  const session = sessionOf();
  const options = { ...overrides };
  for (let count = 1; count <= passSteps.length; count += 1) await reported(session, passSteps.slice(0, count).flat(), options);
  const lastReported = await buildAt(session, passSteps.flat(), options);
  const kept = [...lastReported.input, ...itemsOf(NEXT_TURN)];
  return {
    session,
    options,
    kept,
    keptMeasure: await measure(session.meter, kept),
    memberAlone: await measure(session.meter, withEvicted(kept, passMembers.slice(0, 1))),
    pass: withEvicted(kept, passMembers),
    passMeasure: await measure(session.meter, withEvicted(kept, passMembers)),
  };
};

const trailOf = (session: Session) => (): string => `sent counts during the build: ${JSON.stringify(session.sentCounts.at(-1))}`;

describe('R1: the eviction pass is the unit, judged by the fit test’s own measure', () => {
  for (const layout of [undefined, 'cachePrefix'] as const) {
    it(`keeps a fitting pass whose oldest member alone would push the input over I0 (layout ${layout ?? 'default'})`, async () => {
      const fixture = await passFixture(layout === undefined ? {} : { layout });
      expect(fixture.keptMeasure).toEqual({ tokens: 2669, known: 2568, uncounted: 101, bound: 31 });
      expect(fixture.memberAlone).toEqual({ tokens: 2658, known: 1527, uncounted: 2568 - 1527 + (2658 - 1527), bound: 653 });
      expect(fixture.passMeasure).toEqual({ tokens: 2296, known: 1527, uncounted: 2568 - 1527 + (2296 - 1527), bound: 544 });
      expect(loadOf(fixture.keptMeasure)).toBeLessThanOrEqual(I);
      expect(loadOf(fixture.memberAlone)).toBeGreaterThan(I);
      expect(loadOf(fixture.passMeasure)).toBeLessThanOrEqual(I);

      const built = await builtOf(buildAt(fixture.session, [...passSteps.flat(), ...NEXT_TURN], fixture.options), trailOf(fixture.session));
      expect(omittedIds(built)).toEqual(['c0', 'c1', 'c2']);
      expect(built.input).toEqual(fixture.pass);
      expect(built.inputTokens).toBe(2296);
      expect(built.budget.I).toBe(I - 544);
    });
  }

  it('keeps a pass over 500-character arguments reported after every step, 2261+50 becoming 2250+388, and the next build counts from that request', async () => {
    const steps: HistoryItem[][] = [
      [argsCall(1, 'c0', 0), output(2, 'c0', 'r'.repeat(120))],
      ...[1, 2, 3, 4, 5].map((index) => [argsCall(2 * index + 1, `c${index}`, 500), output(2 * index + 2, `c${index}`, 'ok')]),
    ];
    const target = steps[0]?.[1] as HistoryItem;
    const session = sessionOf();
    for (let count = 1; count <= 4; count += 1) await reported(session, steps.slice(0, count).flat());
    const lastReported = await buildAt(session, steps.slice(0, 4).flat());
    const kept = [...lastReported.input, ...itemsOf(steps[4] as HistoryItem[])];
    const keptMeasure = await measure(session.meter, kept);
    const evictedMeasure = await measure(session.meter, withEvicted(kept, [target]));
    expect(keptMeasure).toEqual({ tokens: 2261, known: 2095, uncounted: 166, bound: 50 });
    expect(evictedMeasure).toEqual({ tokens: 2250, known: 1527, uncounted: 1291, bound: 388 });

    const built = await builtOf(reported(session, steps.slice(0, 5).flat()), trailOf(session));
    expect(omittedIds(built)).toEqual(['c0']);
    expect(built.input).toEqual(withEvicted(kept, [target]));
    expect(built.inputTokens).toBe(2250);
    expect(built.budget.I).toBe(I - 388);

    const next = await builtOf(buildAt(session, steps.flat(), { evicted: new Set(['c0']) }), trailOf(session));
    const newStep = itemsOf(steps[5] as HistoryItem[]);
    expect(next.input).toEqual([...built.input, ...newStep]);
    expect(session.sentCounts.at(-1)?.[0]).toEqual({ tokens: 2416, known: 2250, uncounted: 166, bound: Math.ceil(0.3 * 166) });
    expect(next.inputTokens).toBe(2416);
    expect(next.budget.I).toBe(I - Math.ceil(0.3 * 166));
  });

  it('keeps a pass that lowers the load of an input that does not fit, and the error carries the lowered load', async () => {
    const session = sessionOf();
    await reported(session, []);
    const history: HistoryItem[] = withTurnsBeforeCurrent([
      argsCall(1, 'c0', 0),
      output(2, 'c0', 'a'.repeat(800)),
      argsCall(3, 'c1', 0),
      output(4, 'c1', 'b'.repeat(800)),
      assistant(5, 'first part done'),
      user(6, 'continue'),
      argsCall(7, 'c2', 4000),
      output(8, 'c2', 'ok'),
    ]);
    const unevicted = await buildAt(sessionOf(), history.slice(0, 4));
    const kept = [...unevicted.input, ...itemsOf(history.slice(4))];
    const keptMeasure = await measure(session.meter, kept);
    const passMeasure = await measure(session.meter, withEvicted(kept, [history[1], history[3]] as HistoryItem[]));
    expect(loadOf(keptMeasure)).toBeGreaterThan(I);
    expect(loadOf(passMeasure)).toBeLessThan(loadOf(keptMeasure));
    expect(loadOf(passMeasure)).toBeGreaterThan(I);

    const error = await overflowOf(buildAt(session, history, {}));
    expect(error.level).toBe(0);
    expect(error.inputTokens).toBe(passMeasure.tokens);
    expect(error.inputBudget).toBe(I - passMeasure.bound);
    expect(error.inputTokens + (I - error.inputBudget)).toBeLessThan(loadOf(keptMeasure));
  });

  it('refuses a pass that raises the load of an input that does not fit: the error reports the unevicted input', async () => {
    const steps: HistoryItem[][] = [
      [argsCall(1, 'c0', 0), output(2, 'c0', 'r'.repeat(120))],
      ...[1, 2, 3, 4].map((index) => [argsCall(2 * index + 1, `c${index}`, index === 4 ? 1600 : 1000), output(2 * index + 2, `c${index}`, 'ok')]),
    ];
    const session = sessionOf();
    for (let count = 1; count <= 4; count += 1) await reported(session, steps.slice(0, count).flat());
    const lastReported = await buildAt(session, steps.slice(0, 4).flat());
    const kept = [...lastReported.input, ...itemsOf(steps[4] as HistoryItem[])];
    const keptMeasure = await measure(session.meter, kept);
    const evictedMeasure = await measure(session.meter, withEvicted(kept, [steps[0]?.[1] as HistoryItem]));
    expect(keptMeasure).toEqual({ tokens: 2911, known: 2470, uncounted: 441, bound: 133 });
    expect(evictedMeasure).toEqual({ tokens: 2900, known: 1527, uncounted: 2316, bound: 695 });

    const error = await overflowOf(buildAt(session, steps.flat()));
    expect(error.level).toBe(0);
    expect(error.inputTokens).toBe(2911);
    expect(error.inputBudget).toBe(I - 133);
    expect(error.evictions).toEqual([]);
  });

  it('restores the input exactly after a refused pass with M6 forms on: no re-truncated or restored form, no truncation report, no count of the pass', async () => {
    const forms = new Map([['c2', 1]]);
    const options: Partial<BuildContextInput> = { forms, renderedFull: new Set(['c3']) };
    const steps: HistoryItem[][] = [
      [argsCall(1, 'c0', 0), output(2, 'c0', 'r'.repeat(120))],
      [argsCall(3, 'c1', 1000), output(4, 'c1', 'ok')],
      [argsCall(5, 'c2', 1000), output(6, 'c2', 'frozen form')],
      [argsCall(7, 'c3', 600), output(8, 'c3', 'z'.repeat(400))],
      [argsCall(9, 'c4', 1000), output(10, 'c4', 'ok')],
    ];
    const session = sessionOf();
    for (let count = 1; count <= 4; count += 1) await reported(session, steps.slice(0, count).flat(), options);
    const lastReported = await buildAt(session, steps.slice(0, 4).flat(), options);
    const kept = [...lastReported.input, ...itemsOf(steps[4] as HistoryItem[])];
    const keptMeasure = await measure(session.meter, kept);
    const frozenC2 = kept.find((item) => item.type === 'function_call_output' && item.call_id === 'c2');
    const fullC3 = kept.find((item) => item.type === 'function_call_output' && item.call_id === 'c3');
    expect(frozenC2).not.toEqual(steps[2]?.[1]?.item);
    expect(fullC3).toEqual(steps[3]?.[1]?.item);
    expect(tokensOfItem(fullC3 as InputItem)).toBeGreaterThan(64);
    expect(loadOf(keptMeasure)).toBeLessThanOrEqual(I);
    expect(loadOf(await measure(session.meter, withEvicted(kept, [steps[0]?.[1] as HistoryItem])))).toBeGreaterThan(I);

    const built = await builtOf(buildAt(session, steps.flat(), options), trailOf(session));
    expect(built.evictions).toEqual([]);
    expect(built.input).toEqual(kept);
    expect(built.inputTokens).toBe(keptMeasure.tokens);
    expect(built.inputDigest).toBe((await session.meter.count({ input: kept, tools: [] })).inputDigest);
    expect(built.budget.I).toBe(I - keptMeasure.bound);
  });

  it('refuses a group of a referent and its unprotected copy inside the reported prefix when the pass would stop the input fitting', async () => {
    const referent = 'first-read-of-the-shared-output';
    const shared = 'r'.repeat(120);
    const steps: HistoryItem[][] = [
      [argsCall(1, referent, 0), output(2, referent, shared)],
      [argsCall(3, 'c1', 0), output(4, 'c1', shared)],
      [argsCall(5, 'c2', 1000), output(6, 'c2', 'ok')],
      [argsCall(7, 'c3', 1800), output(8, 'c3', 'ok')],
    ];
    const options: Partial<BuildContextInput> = { outputFormatters: ['identicalOutput'] };
    const session = sessionOf();
    for (let count = 1; count <= steps.length; count += 1) await reported(session, steps.slice(0, count).flat(), options);
    const lastReported = await buildAt(session, steps.flat(), options);
    const kept = [...lastReported.input, ...itemsOf(NEXT_TURN)];
    const reference = `[identical to the output of call ${referent}; stored as ${handleOf(shared)}; read it with ReadOutput]`;
    expect(kept.find((item) => item.type === 'function_call_output' && item.call_id === 'c1')).toEqual({ ...(steps[1]?.[1]?.item as InputItem), output: reference });
    const keptMeasure = await measure(session.meter, kept);
    const groupEvicted = withEvicted(kept, [steps[0]?.[1], steps[1]?.[1]] as HistoryItem[]);
    const groupMeasure = await measure(session.meter, groupEvicted);
    expect(tokensOfItem(groupEvicted.find((item) => item.type === 'function_call_output' && item.call_id === referent) as InputItem)).toBeLessThan(
      tokensOfItem(steps[0]?.[1]?.item as InputItem),
    );
    expect(loadOf(keptMeasure)).toBeLessThanOrEqual(I);
    expect(loadOf(groupMeasure)).toBeGreaterThan(I);

    const built = await builtOf(buildAt(session, [...steps.flat(), ...NEXT_TURN], options), trailOf(session));
    expect(omittedIds(built)).toEqual([]);
    expect(built.input).toEqual(kept);
    expect(built.inputTokens).toBe(keptMeasure.tokens);
    expect(built.budget.I).toBe(I - keptMeasure.bound);
  });

  it('control: an exact counter applies an in-prefix pass that fits, as today', async () => {
    const steps: HistoryItem[][] = [
      [argsCall(1, 'c0', 0), output(2, 'c0', 'r'.repeat(120))],
      ...[1, 2, 3, 4].map((index) => [argsCall(2 * index + 1, `c${index}`, 1000), output(2 * index + 2, `c${index}`, 'ok')]),
    ];
    const session = sessionOf(EXACT, fakeCounter(0));
    for (let count = 1; count <= 4; count += 1) await reported(session, steps.slice(0, count).flat());
    const lastReported = await buildAt(session, steps.slice(0, 4).flat());
    const kept = [...lastReported.input, ...itemsOf(steps[4] as HistoryItem[])];
    const evicted = withEvicted(kept, [steps[0]?.[1] as HistoryItem]);
    const evictedMeasure = await measure(session.meter, evicted);
    expect(evictedMeasure).toEqual({ tokens: 2750, known: 1527, uncounted: 2166, bound: 0 });

    const built = await builtOf(buildAt(session, steps.flat()), trailOf(session));
    expect(omittedIds(built)).toEqual(['c0']);
    expect(built.input).toEqual(evicted);
    expect(built.inputTokens).toBe(2750);
    expect(built.budget.I).toBe(budgetFor(EXACT, 0).I);
  });

  it('control: a fresh decomposition, with no report, applies the pass as today', async () => {
    const steps: HistoryItem[][] = [
      [argsCall(1, 'c0', 0), output(2, 'c0', 'r'.repeat(120))],
      ...[1, 2, 3, 4].map((index) => [argsCall(2 * index + 1, `c${index}`, 500), output(2 * index + 2, `c${index}`, 'ok')]),
    ];
    const session = sessionOf();
    const unevicted = await buildAt(sessionOf(), steps.slice(0, 4).flat());
    const kept = [...unevicted.input, ...itemsOf(steps[4] as HistoryItem[])];
    const evicted = withEvicted(kept, [steps[0]?.[1] as HistoryItem]);
    const keptMeasure = await measure(sessionOf().meter, kept);
    const evictedMeasure = await measure(sessionOf().meter, evicted);
    expect(keptMeasure).toEqual({ tokens: 2261, known: 0, uncounted: 2261, bound: Math.ceil(0.3 * 2261) });
    expect(evictedMeasure).toEqual({ tokens: 2250, known: 0, uncounted: 2250, bound: Math.ceil(0.3 * 2250) });

    const built = await builtOf(buildAt(session, steps.flat()), trailOf(session));
    expect(omittedIds(built)).toEqual(['c0']);
    expect(built.input).toEqual(evicted);
    expect(built.inputTokens).toBe(2250);
    expect(built.budget.I).toBe(I - Math.ceil(0.3 * 2250));
  });
});
