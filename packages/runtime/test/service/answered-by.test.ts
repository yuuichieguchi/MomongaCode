import { describe, expect, it } from 'vitest';
import { answeredByOf } from '../../src/service/answered-by.ts';

type FakeEvent = { type: string; [key: string]: unknown };

const storeOf = (events: FakeEvent[]) => ({
  readRunEventsOfTypes: (_runId: string, types: readonly string[]) => events.filter((event) => types.includes(event.type)),
});

const started = (targets: unknown): FakeEvent => ({ type: 'run.started', attempt: 1, now: 0, pins: { modelAlias: 'default', targets } });

const observed = (target: string): FakeEvent => ({ type: 'meter.observed', target, counter: 'c', fallback: false });

const TARGETS = {
  opus: { adapter: 'anthropic', model: 'claude-opus', answers: 'model' },
  scripted: { adapter: 'chat-completions', model: 'fake-model', answers: 'script' },
  local: { adapter: 'ollama', model: 'llama3' },
};

const answeredBy = (events: FakeEvent[]) => answeredByOf(storeOf(events) as unknown as Parameters<typeof answeredByOf>[0], 'run-1');

describe('what answered a run, from its meter observations and its pins', () => {
  it('names each answering target once, with the adapter, the upstream model and the pinned answers', () => {
    expect(answeredBy([started(TARGETS), observed('opus'), observed('opus'), observed('scripted')])).toEqual([
      { target: 'opus', adapter: 'anthropic', upstreamModel: 'claude-opus', answers: 'model' },
      { target: 'scripted', adapter: 'chat-completions', upstreamModel: 'fake-model', answers: 'script' },
    ]);
  });

  it('reports a target the settings never declared as unknown, never as a model', () => {
    expect(answeredBy([started(TARGETS), observed('local')])).toEqual([{ target: 'local', adapter: 'ollama', upstreamModel: 'llama3', answers: 'unknown' }]);
  });

  it('reads the pins of the run, so a target that a settings change later declared script stays what it was pinned as', () => {
    const pinned = { opus: { adapter: 'anthropic', model: 'claude-opus', answers: 'model' } };
    expect(answeredBy([started(pinned), observed('opus')])[0]?.answers).toBe('model');
  });

  it('answers with no target when no response was observed', () => {
    expect(answeredBy([started(TARGETS)])).toEqual([]);
  });

  it('refuses a run that pinned no targets instead of guessing what answered it', () => {
    expect(() => answeredBy([{ type: 'run.started', attempt: 1, now: 0, pins: { modelAlias: 'default' } }, observed('opus')])).toThrow(/pinned no targets/);
  });

  it('refuses a response of a target the pins do not list', () => {
    expect(() => answeredBy([started({ opus: TARGETS.opus }), observed('ghost')])).toThrow(/ghost/);
  });
});
