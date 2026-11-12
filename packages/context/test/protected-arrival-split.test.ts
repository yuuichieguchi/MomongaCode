import { describe, expect, it } from 'vitest';
import type { InputItem } from '@momonga/protocol';
import { buildContext, createTokenMeter } from '@momonga/context';
import type { BuildContextInput, BuildContextPorts, BuiltContext, HistoryItem, MeterCount, TokenMeter } from '@momonga/context';
import { HOME, MODEL, PROJECT, assistant, call, capabilitiesFor, fakeBlobs, fakeCounter, fakeReader, output, sourcesWith, touchedFile } from './helpers.ts';
import { TEST_FENCE } from '@momonga/testkit';

const capabilities = capabilitiesFor(200_000);
const NESTED = '/proj/sub/AGENTS.md';
const ARRIVAL_CONTENT = `Contents of ${NESTED}:\n${'r'.repeat(4000)}`;
const arrivalItem = (seq: number): HistoryItem => ({ seq, item: { type: 'message', role: 'developer', content: ARRIVAL_CONTENT } satisfies InputItem });

const inputWith = (history: HistoryItem[], extra: Partial<BuildContextInput> = {}): BuildContextInput => ({
  capabilities,
  fence: TEST_FENCE,
  model: MODEL,
  sources: sourcesWith({ history }),
  evicted: new Set<string>(),
  recordedReferences: new Set<string>(),
  touchedPaths: [],
  trusted: true,
  projectRoot: PROJECT,
  home: HOME,
  observedCapacity: true,
  renderedFull: new Set(['c1', 'c2']),
  ...extra,
});

type Reported = { ports: BuildContextPorts; sent: MeterCount[]; first: BuiltContext };

const reported = async (): Promise<Reported> => {
  const inner = createTokenMeter({ counter: fakeCounter(0), model: MODEL, capabilities, observedCapacity: true });
  const sent: MeterCount[] = [];
  const meter: TokenMeter = {
    ...inner,
    count: async (request) => {
      const counted = await inner.count(request);
      if (request.sent === true) sent.push(counted);
      return counted;
    },
  };
  const ports: BuildContextPorts = { meter, blobs: fakeBlobs(), instructions: fakeReader({ [NESTED]: 'n'.repeat(4000) }) };
  const first = await buildContext(inputWith([assistant(1, 'plan')]), ports);
  meter.observe({ inputDigest: first.inputDigest, inputTokens: first.inputTokens });
  sent.length = 0;
  return { ports, sent, first };
};

const knownOf = (run: Reported, built: BuiltContext): number => {
  const counted = run.sent.findLast((entry) => entry.inputDigest === built.inputDigest);
  if (counted === undefined) throw new Error('no sent count for the built input');
  return counted.known;
};

const step = (items: HistoryItem[]): HistoryItem[] => [assistant(1, 'plan'), ...items];

describe('a protected arrival kept in history, against the meter split rule (callClosedBoundary)', () => {
  it('after both outputs of the new step: j stays at the whole reported request', async () => {
    const run = await reported();
    const built = await buildContext(inputWith(step([call(2, 'c1'), call(3, 'c2'), output(4, 'c1', 'x'.repeat(400)), output(5, 'c2', 'y'.repeat(400)), arrivalItem(6)])), run.ports);

    expect(knownOf(run, built)).toBe(run.first.inputTokens);
  });

  it('between the outputs of two parallel calls of the new step: j still stays at the whole reported request', async () => {
    const run = await reported();
    const built = await buildContext(inputWith(step([call(2, 'c1'), call(3, 'c2'), output(4, 'c1', 'x'.repeat(400)), arrivalItem(5), output(6, 'c2', 'y'.repeat(400))])), run.ports);

    expect(knownOf(run, built)).toBe(run.first.inputTokens);
  });

  it('between a call and its own output: j still stays, because the open span starts after the reported request', async () => {
    const run = await reported();
    const built = await buildContext(inputWith(step([call(2, 'c1'), arrivalItem(3), output(4, 'c1', 'x'.repeat(400))])), run.ports);

    expect(knownOf(run, built)).toBe(run.first.inputTokens);
  });

  it('control, the arrival placed in F as today: j falls to the end of the pinned layers', async () => {
    const run = await reported();
    const built = await buildContext(
      inputWith(step([call(2, 'c1'), output(3, 'c1', 'x'.repeat(400))]), { touchedPaths: [touchedFile('/proj/sub/x.ts')] }),
      run.ports,
    );

    expect(knownOf(run, built)).toBeLessThan(run.first.inputTokens);
  });
});

const small = capabilitiesFor(8192, { tokenCounting: 'estimated', maxOutputTokens: 1024 });
const carries = (items: readonly InputItem[]): boolean => items.some((item) => item.type === 'message' && item.role === 'developer' && JSON.stringify(item.content).includes(NESTED));

const outputHeavy: HistoryItem[] = [
  arrivalItem(2),
  ...[1, 2, 3, 4, 5].flatMap((index): HistoryItem[] => [call(10 * index, `c${index}`), output(10 * index + 1, `c${index}`, 'o'.repeat(3000))]),
  assistant(60, 'done'),
];

const assistantHeavy: HistoryItem[] = [
  arrivalItem(2),
  ...[1, 2, 3, 4, 5, 6, 7].flatMap((index): HistoryItem[] => [call(10 * index, `c${index}`), output(10 * index + 1, `c${index}`, 'ok'), assistant(10 * index + 2, 'z'.repeat(3000))]),
];

const smallInput = (history: HistoryItem[], level: number): BuildContextInput => ({
  ...inputWith(history, { keepRecentTurns: 1, level }),
  capabilities: small,
  renderedFull: new Set(history.flatMap((entry) => (entry.item.type === 'function_call_output' ? [entry.item.call_id] : []))),
});

const smallPorts = (): BuildContextPorts => ({
  meter: createTokenMeter({ counter: fakeCounter(0), model: MODEL, capabilities: small, observedCapacity: true }),
  blobs: fakeBlobs(),
  instructions: fakeReader({}),
});

describe('a protected arrival kept in history, against eviction and compaction', () => {
  it('eviction replaces tool outputs with markers and never touches the arrival message', async () => {
    const built = await buildContext(smallInput(outputHeavy, 1), smallPorts());

    expect(built.evictions.filter((entry) => entry.kind === 'omitted').length).toBeGreaterThan(0);
    expect(carries(built.input)).toBe(true);
  });

  it('a compaction plan takes the arrival into its input and its cut lies after the arrival, so the summary replaces it', async () => {
    const built = await buildContext(smallInput(assistantHeavy, 0), smallPorts());
    const plan = built.compaction;

    expect(plan).toBeDefined();
    expect(plan?.throughSeq).toBeGreaterThan(2);
    expect(carries(plan?.input ?? [])).toBe(true);
  });
});
