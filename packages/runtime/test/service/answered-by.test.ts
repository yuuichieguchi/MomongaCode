import { describe, expect, it } from 'vitest';
import { answeredByOf } from '../../src/service/answered-by.ts';
import { expectSchema } from './helpers.ts';

type FakeEvent = { type: string; [key: string]: unknown };

const started = (targets: unknown): FakeEvent => ({ type: 'run.started', attempt: 1, now: 0, pins: { model: 'default', targets } });

const observed = (target: string): FakeEvent => ({ type: 'meter.observed', target, counter: 'c', fallback: false });

const TARGETS = {
  opus: { adapter: 'anthropic', model: 'claude-opus', answers: 'model' },
  scripted: { adapter: 'chat-completions', model: 'fake-model', answers: 'script' },
  local: { adapter: 'ollama', model: 'llama3' },
};

const countingStore = (events: FakeEvent[], answering: string[]) => {
  const readTypes: string[][] = [];
  const store = {
    readRunEventsOfTypes: (_runId: string, types: readonly string[]) => {
      readTypes.push([...types]);
      return events.filter((event) => types.includes(event.type));
    },
    answeringTargetsOf: (_runId: string) => [...answering],
  };
  return { store, readTypes };
};

const answeredBy = async (events: FakeEvent[], answering: string[]) => {
  const { store, readTypes } = countingStore(events, answering);
  const view = await answeredByOf(store as unknown as Parameters<typeof answeredByOf>[0], 'run-1');
  return { view, readTypes };
};

describe('what answered a run, from the per-run answerers record and its pins', () => {
  it('names each answering target with the adapter, the upstream model and the pinned answers', async () => {
    expect((await answeredBy([started(TARGETS)], ['opus', 'scripted'])).view).toStrictEqual([
      { target: 'opus', adapter: 'anthropic', upstreamModel: 'claude-opus', answers: 'model' },
      { target: 'scripted', adapter: 'chat-completions', upstreamModel: 'fake-model', answers: 'script' },
    ]);
  });

  it('reads no meter.observed event, whatever the journal holds, and takes the targets from the record', async () => {
    const { view, readTypes } = await answeredBy([started(TARGETS), observed('local'), observed('local')], ['opus']);
    expect(view.map((entry) => entry.target)).toEqual(['opus']);
    expect(readTypes.flat()).not.toContain('meter.observed');
    expect(readTypes.flat().every((type) => type === 'run.started')).toBe(true);
  });

  it('reports a target the settings never declared as unknown, never as a model', async () => {
    expect((await answeredBy([started(TARGETS)], ['local'])).view).toStrictEqual([{ target: 'local', adapter: 'ollama', upstreamModel: 'llama3', answers: 'unknown' }]);
  });

  it('an unknown answerer is not looked up in the pins and has no adapter and no upstreamModel field', async () => {
    const { view } = await answeredBy([started(TARGETS)], ['opus', 'unknown']);
    expect(view).toStrictEqual([
      { target: 'opus', adapter: 'anthropic', upstreamModel: 'claude-opus', answers: 'model' },
      { target: 'unknown', answers: 'unknown' },
    ]);
    expect(Object.keys(view[1] ?? {})).toEqual(['target', 'answers']);
  });

  it('the RunAnsweredBy response schema accepts an unknown answerer without adapter and upstreamModel', async () => {
    expect(() => expectSchema('RunAnsweredBy', { answeredBy: [{ target: 'unknown', answers: 'unknown' }] })).not.toThrow();
  });

  it('reads the pins of the run, so a target that a settings change later declared script stays what it was pinned as', async () => {
    const pinned = { opus: { adapter: 'anthropic', model: 'claude-opus', answers: 'model' } };
    expect((await answeredBy([started(pinned)], ['opus'])).view[0]?.answers).toBe('model');
  });

  it('answers with no target when the record names none', async () => {
    expect((await answeredBy([started(TARGETS)], [])).view).toEqual([]);
  });

  it('refuses a run that pinned no targets instead of guessing what answered it', async () => {
    await expect(answeredBy([{ type: 'run.started', attempt: 1, now: 0, pins: { model: 'default' } }], ['opus'])).rejects.toThrow(/pinned no targets/);
  });

  it('answers a recorded answerer that the pins do not list with its text and no adapter, as an old run recorded a name that is no key of its pins', async () => {
    expect((await answeredBy([started({ opus: TARGETS.opus })], ['ghost', 'opus'])).view).toEqual([
      { target: 'ghost', answers: 'unknown' },
      { target: 'opus', adapter: TARGETS.opus.adapter, upstreamModel: TARGETS.opus.model, answers: TARGETS.opus.answers ?? 'unknown' },
    ]);
  });
});
