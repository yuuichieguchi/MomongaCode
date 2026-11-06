import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicRunEvent } from '@momonga/protocol';
import { createMapperState, mapRunEvent } from '../src/acp/events.ts';
import type { ClientFeatures, Effect } from '../src/acp/events.ts';
import { createFrameSink } from '../src/run/headless.ts';
import type { RunEventFrame } from '../src/client/runtime-client.ts';
import { initialTranscript, reduceEvent } from '../src/tui/transcript.ts';
import type { Transcript } from '../src/tui/transcript.ts';

const RETRY_AT = new Date(2026, 10, 7, 23, 41, 5).getTime();
const RETRY_TIME = '23:41:05';
const UNREACHABLE_LINE = `Waiting to reach the provider (attempt 3 of 20). Retrying at ${RETRY_TIME}.`;

const unreachable = { type: 'attempt.failed', attempt: 3, code: 'provider_unavailable', retryAt: RETRY_AT, limit: 20 };
const deferred = { type: 'attempt.failed', attempt: 3, code: 'rate_limited', retryAt: RETRY_AT, limit: 20 };
const earlier = { type: 'attempt.failed', attempt: 2, code: 'provider_unavailable', retryAt: RETRY_AT - 4_000, limit: 20 };
const toQueued = { type: 'run.status', from: 'RUNNING', to: 'QUEUED' };
const toRunning = { type: 'run.status', from: 'QUEUED', to: 'RUNNING' };

const namesTheDeferral = (text: string): boolean => /wait/i.test(text) && /\b3\b/.test(text) && /\b20\b/.test(text) && text.includes(RETRY_TIME);

const eventsOf = (payloads: readonly Record<string, unknown>[]): PublicRunEvent[] =>
  payloads.map((payload, index) => ({ id: index + 1, runId: 'run-1', sessionId: 'session-1', seq: index + 1, step: 1, createdAt: 1, ...payload }) as PublicRunEvent);

const headlessLines = (payloads: readonly Record<string, unknown>[]): string[] => {
  const out: string[] = [];
  const err: string[] = [];
  const sink = createFrameSink({ stdout: { write: (text: string) => void out.push(text) }, stderr: { write: (text: string) => void err.push(text) } } as never, 'text', false);
  for (const event of eventsOf(payloads)) sink.handle({ id: event.id, event: event.type, data: event } as RunEventFrame);
  expect(out).toEqual([]);
  return err.join('').split('\n').filter((line) => line.length > 0);
};

const ALL: ClientFeatures = { notices: true, compaction: true, elicitation: { form: true, url: true } };
const NONE: ClientFeatures = { notices: false, compaction: false, elicitation: { form: false, url: false } };

const acpEffects = (payloads: readonly Record<string, unknown>[], features: ClientFeatures): Effect[] => {
  const state = createMapperState();
  return eventsOf(payloads).flatMap((event) => mapRunEvent(event, 'live', state, features));
};

const noticeTitles = (effects: readonly Effect[]): string[] =>
  effects.flatMap((effect) => (effect.kind === 'update' && effect.update.sessionUpdate === 'notice' ? [String((effect.update as { title: unknown }).title)] : []));

const chunkTexts = (effects: readonly Effect[]): string[] =>
  effects.flatMap((effect) => {
    if (effect.kind !== 'update' || effect.update.sessionUpdate !== 'agent_message_chunk') return [];
    const content = (effect.update as { content: { text?: unknown } }).content;
    return [String(content.text)];
  });

const transcriptOf = (payloads: readonly Record<string, unknown>[]): Transcript => eventsOf(payloads).reduce<Transcript>(reduceEvent, initialTranscript);

const shownBy = (transcript: Transcript): string[] => [
  ...transcript.entries.flatMap((entry) => ('text' in entry ? [entry.text] : [])),
  ...(transcript.waiting === undefined ? [] : [transcript.waiting]),
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('a headless run prints the wait of a QUEUED run on stderr (decision 67)', () => {
  it('prints the unreachable-provider wait with the attempt, the limit and the time from retryAt', () => {
    const lines = headlessLines([unreachable, toQueued]);
    expect(lines.filter((line) => line.includes(UNREACHABLE_LINE))).toHaveLength(1);
  });

  it('prints a deferral wait with the attempt, the limit and the time from retryAt', () => {
    const lines = headlessLines([deferred, toQueued]);
    expect(lines.filter(namesTheDeferral)).toHaveLength(1);
  });

  it('prints the wait of each failure, the last one carrying its own attempt', () => {
    const lines = headlessLines([earlier, toQueued, toRunning, unreachable, toQueued]);
    expect(lines.at(-1) ?? '').toContain(UNREACHABLE_LINE);
    expect(lines.some((line) => line.includes('attempt 2 of 20'))).toBe(true);
  });
});

describe('an ACP client is told the wait of a QUEUED run as a session notice (decision 67)', () => {
  it('sends the unreachable-provider wait as a notice to a client that takes notices', () => {
    expect(noticeTitles(acpEffects([unreachable, toQueued], ALL))).toEqual([UNREACHABLE_LINE]);
  });

  it('sends the same line as a message chunk to a client without notices', () => {
    expect(chunkTexts(acpEffects([unreachable, toQueued], NONE)).filter((text) => text.includes(UNREACHABLE_LINE))).toHaveLength(1);
  });

  it('sends a deferral wait with the attempt, the limit and the time from retryAt', () => {
    const titles = noticeTitles(acpEffects([deferred, toQueued], ALL));
    expect(titles).toHaveLength(1);
    expect(namesTheDeferral(titles[0] ?? '')).toBe(true);
  });
});

describe('the TUI shows the wait of a QUEUED run (decision 67)', () => {
  it('shows the unreachable-provider wait with the attempt, the limit and the time from retryAt', () => {
    expect(shownBy(transcriptOf([unreachable, toQueued])).filter((text) => text.includes(UNREACHABLE_LINE)).length).toBeGreaterThanOrEqual(1);
  });

  it('shows a deferral wait with the attempt, the limit and the time from retryAt', () => {
    expect(shownBy(transcriptOf([deferred, toQueued])).some(namesTheDeferral)).toBe(true);
  });

  it('shows the last failure of the run when it failed more than once', () => {
    const transcript = transcriptOf([earlier, toQueued, toRunning, unreachable, toQueued]);
    expect(shownBy(transcript).some((text) => text.includes(UNREACHABLE_LINE))).toBe(true);
    expect(transcript.waiting ?? '').not.toContain('attempt 2 of 20');
  });

  it('no longer holds the wait in the footer once the run is claimed again', () => {
    const transcript = transcriptOf([unreachable, toQueued, toRunning]);
    expect(transcript.waiting ?? '').not.toContain(UNREACHABLE_LINE);
  });
});
