import { describe, expect, it } from 'vitest';
import type { RunEvent, RunEventPayload, RunState } from '@momonga/protocol';
import { foldRunState, initialRunState } from '@momonga/store';
import { FIXTURE_RUN_ID, FIXTURE_SESSION_ID, fixtureCompactionItem, materializeEvents } from '@momonga/testkit';
import { TEST_FENCE } from '@momonga/testkit';

const start = (): RunState => initialRunState({ runId: FIXTURE_RUN_ID, sessionId: FIXTURE_SESSION_ID, fence: TEST_FENCE });
const foldAll = (events: readonly RunEvent[], from: RunState = start()): RunState => events.reduce(foldRunState, from);
const foldPayloads = (payloads: readonly RunEventPayload[]): RunState => foldAll(materializeEvents(payloads));

const USAGE = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };

const task: RunEventPayload = { type: 'user.message', text: 'go' };
const requested = (step: number, attempt = 1): RunEventPayload => ({ type: 'model.requested', step, attempt, digest: `d${step}.${attempt}`, body: { input: 'go' } });
const responded = (step: number, attempt = 1): RunEventPayload => ({
  type: 'model.responded',
  step,
  attempt,
  response: { status: 'completed', output: [{ type: 'message', id: `m${step}`, role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }], usage: USAGE },
});
const message = (step: number, itemId: string, text: string, attempt = 1): RunEventPayload => ({ type: 'agent.message.delta', step, attempt, itemId, text });
const thought = (step: number, itemId: string, text: string, attempt = 1): RunEventPayload => ({ type: 'agent.thought.delta', step, attempt, itemId, text });
const restarted = (step: number, attempt: number, itemIds: string[]): RunEventPayload => ({ type: 'model.stream.restarted', step, attempt, itemIds });

describe('RunState.streaming fold', () => {
  it('accumulates message deltas per itemId in first-appearance order', () => {
    const state = foldPayloads([task, requested(1), message(1, 'b', 'Hel'), message(1, 'a', 'Second'), message(1, 'b', 'lo'), message(1, 'a', ' part')]);
    expect(state.streaming).toEqual({
      step: 1,
      attempt: 1,
      seen: true,
      items: [
        { itemId: 'b', text: 'Hello' },
        { itemId: 'a', text: 'Second part' },
      ],
      thoughtIds: [],
    });
  });

  it('creates a record with seen, no items and the thought id from a thought delta alone', () => {
    const state = foldPayloads([task, requested(1), thought(1, 'r1', 'thinking')]);
    expect(state.streaming).toEqual({ step: 1, attempt: 1, seen: true, items: [], thoughtIds: ['r1'] });
  });

  it('adds no text for a thought delta but keeps the message text', () => {
    const state = foldPayloads([task, requested(1), message(1, 'm', 'visible'), thought(1, 'r1', 'hidden reasoning')]);
    expect(state.streaming).toEqual({ step: 1, attempt: 1, seen: true, items: [{ itemId: 'm', text: 'visible' }], thoughtIds: ['r1'] });
  });

  it('is undefined when nothing streamed', () => {
    expect(foldPayloads([task, requested(1)]).streaming).toBeUndefined();
  });

  it('is cleared by a model.stream.restarted that names every entry of the stream', () => {
    expect(foldPayloads([task, requested(1), message(1, 'm', 'discarded'), thought(1, 'r', 'gone'), restarted(1, 1, ['m', 'r'])]).streaming).toBeUndefined();
  });

  it('is kept by a model.stream.restarted that names none of its entries, whatever its step and attempt', () => {
    const state = foldPayloads([task, requested(2), message(2, 'm', 'kept'), restarted(2, 1, [])]);
    expect(state.streaming).toEqual({ step: 2, attempt: 1, seen: true, items: [{ itemId: 'm', text: 'kept' }], thoughtIds: [] });
    const otherIds = foldPayloads([task, requested(2), message(2, 'm', 'kept'), restarted(3, 1, ['x'])]);
    expect(otherIds.streaming).toEqual({ step: 2, attempt: 1, seen: true, items: [{ itemId: 'm', text: 'kept' }], thoughtIds: [] });
  });

  it('is cleared by model.requested', () => {
    expect(foldPayloads([task, requested(1), message(1, 'm', 'old'), requested(2)]).streaming).toBeUndefined();
  });

  it('is cleared by model.responded', () => {
    expect(foldPayloads([task, requested(1), message(1, 'm', 'answer'), responded(1)]).streaming).toBeUndefined();
  });

  it('starts a new record when a delta carries another step or attempt', () => {
    const otherAttempt = foldPayloads([task, requested(1), message(1, 'm', 'first'), message(1, 'm', 'second', 2)]);
    expect(otherAttempt.streaming).toEqual({ step: 1, attempt: 2, seen: true, items: [{ itemId: 'm', text: 'second' }], thoughtIds: [] });
    const otherStep = foldPayloads([task, requested(1), message(1, 'm', 'first'), thought(2, 'r', 'x')]);
    expect(otherStep.streaming).toEqual({ step: 2, attempt: 1, seen: true, items: [], thoughtIds: ['r'] });
  });

  it('collects text again after a restart of the same attempt', () => {
    const state = foldPayloads([task, requested(1), message(1, 'm', 'lost'), restarted(1, 1, ['m']), message(1, 'm', 'again')]);
    expect(state.streaming).toEqual({ step: 1, attempt: 1, seen: true, items: [{ itemId: 'm', text: 'again' }], thoughtIds: [] });
  });

  it('does not touch history', () => {
    const state = foldPayloads([task, requested(1), message(1, 'm', 'partial')]);
    expect(state.history.map((entry) => entry.seq)).toEqual([1]);
    expect(state.nextItemSeq).toBe(2);
  });
});

const referenceStreamedBeforeRestart = (events: readonly RunEvent[], position: { step: number; attempt: number }, requestedSeq: number): boolean => {
  let streamed = false;
  for (const event of events) {
    if (event.seq <= requestedSeq) continue;
    if (event.type === 'model.stream.restarted' && event.step === position.step && event.attempt === position.attempt) streamed = false;
    else if ((event.type === 'agent.message.delta' || event.type === 'agent.thought.delta') && event.step === position.step && event.attempt === position.attempt) streamed = true;
  }
  return streamed;
};

const seededRandom = (seed: number): (() => number) => {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const randomJournal = (random: () => number, length: number): RunEventPayload[] => {
  const pick = <T>(choices: readonly T[]): T => choices[Math.floor(random() * choices.length)] as T;
  const payloads: RunEventPayload[] = [task];
  let step = 0;
  let open: { step: number; attempt: number } | undefined;
  let streamed = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const roll = random();
    if (open === undefined || roll < 0.12) {
      step += 1;
      open = { step, attempt: 1 };
      streamed = new Set();
      payloads.push(requested(step));
      continue;
    }
    const restartTarget = random() < 0.8 ? open : { step: open.step, attempt: pick([1, 2]) };
    if (roll < 0.45) {
      const itemId = pick(['a', 'b']);
      streamed.add(itemId);
      payloads.push(message(open.step, itemId, pick(['x', 'yy']), open.attempt));
    } else if (roll < 0.65) {
      streamed.add('r');
      payloads.push(thought(open.step, 'r', 'z', open.attempt));
    } else if (roll < 0.85) {
      const sameStream = restartTarget.step === open.step && restartTarget.attempt === open.attempt;
      payloads.push(restarted(restartTarget.step, restartTarget.attempt, sameStream ? [...streamed] : []));
      if (sameStream) streamed = new Set();
    } else {
      payloads.push(responded(open.step, open.attempt));
      open = undefined;
    }
  }
  return payloads;
};

describe('streaming replaces the restart scan', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])('agrees with the reference scan after every event of seeded journal %d', (seed) => {
    const events = materializeEvents(randomJournal(seededRandom(seed), 60));
    let state = start();
    let checked = 0;
    for (const [index, event] of events.entries()) {
      state = foldRunState(state, event);
      const inFlight = state.inFlightModelRequest;
      if (inFlight === undefined) continue;
      const position = { step: inFlight.step, attempt: inFlight.attempt };
      const scanned = referenceStreamedBeforeRestart(events.slice(0, index + 1), position, inFlight.requestedSeq);
      const folded = state.streaming?.seen === true && state.streaming.step === position.step && state.streaming.attempt === position.attempt;
      expect(folded).toBe(scanned);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('counts a thought-only stream as streamed, as the scan did', () => {
    const events = materializeEvents([task, requested(1), thought(1, 'r', 'z')]);
    const state = foldAll(events);
    expect(referenceStreamedBeforeRestart(events, { step: 1, attempt: 1 }, 2)).toBe(true);
    expect(state.streaming?.seen).toBe(true);
  });
});

describe('snapshot plus tail equals the full fold', () => {
  const journal: RunEventPayload[] = [
    task,
    { type: 'run.status', from: 'QUEUED', to: 'RUNNING' },
    { type: 'run.started', attempt: 1, now: 1, pins: { model: 'fm' }, mode: 'manual' },
    requested(1),
    message(1, 'm', 'hello'),
    thought(1, 'r', 'hmm'),
    restarted(1, 1, ['m', 'r']),
    message(1, 'm', 'again'),
    responded(1),
    { type: 'user.message', text: 'more' },
    { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'so far <x>'), summary: 'so far <x>', replacedThroughSeq: 2 },
    { type: 'context.compaction_rejected', item: { type: 'message', role: 'user', content: '<conversation_summary>\nso far &lt;x>\n</conversation_summary>' } },
    { type: 'run.started', attempt: 2, now: 2, pins: { model: 'other' }, mode: 'plan' },
    requested(2),
    message(2, 'm', 'partial'),
  ];

  const withRejectedRequest: RunEventPayload[] = [
    task,
    { type: 'run.started', attempt: 1, now: 1, pins: {}, mode: 'acceptEdits' },
    requested(1),
    responded(1),
    { type: 'user.message', text: 'more' },
    { type: 'context.compacted', item: fixtureCompactionItem('cmp-1', 'old'), summary: 'old', replacedThroughSeq: 2 },
    requested(2),
    message(2, 'm', 'never shown'),
    restarted(2, 1, ['m']),
    { type: 'context.compaction_rejected', step: 2, attempt: 1, item: { type: 'message', role: 'user', content: '<conversation_summary>\nold\n</conversation_summary>' } },
    requested(3),
    thought(3, 'r', 'x'),
  ];

  it.each([
    ['mode, deltas around a restart and a rejection without step', journal],
    ['a rejection with step and attempt', withRejectedRequest],
  ])('holds at every k for a journal with %s', (_label, payloads) => {
    const events = materializeEvents(payloads);
    const expected = foldAll(events);
    expect(expected.mode).toBeDefined();
    for (let k = 0; k <= events.length; k += 1) {
      const snapshot = JSON.parse(JSON.stringify(foldAll(events.slice(0, k)))) as RunState;
      expect(foldAll(events.slice(k), snapshot)).toEqual(expected);
    }
  });

  it('ends the mixed journal with the folded mode, plain summary and streaming record', () => {
    const state = foldAll(materializeEvents(journal));
    expect(state.mode).toBe('plan');
    expect(state.pins).toEqual({ model: 'fm' });
    expect(state.summary).toEqual({
      item: { type: 'message', role: 'user', content: '<conversation_summary>\nso far &lt;x>\n</conversation_summary>' },
      summary: 'so far <x>',
      replacedThroughSeq: 2,
    });
    expect(state.streaming).toEqual({ step: 2, attempt: 1, seen: true, items: [{ itemId: 'm', text: 'partial' }], thoughtIds: [] });
  });
});
