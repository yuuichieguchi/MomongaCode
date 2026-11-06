import { describe, expect, it } from 'vitest';
import { answeredByOf } from '../../src/service/answered-by.ts';

type FakeEvent = { type: string; [key: string]: unknown };

const storeOf = (events: FakeEvent[], answering: string[]) => {
  const read: string[][] = [];
  return {
    read,
    port: {
      readRunEventsOfTypes: (_runId: string, types: readonly string[]) => {
        read.push([...types]);
        if (types.some((type) => type !== 'run.started')) throw new Error(`answeredByOf read ${types.join(', ')} from the journal`);
        return events.filter((event) => types.includes(event.type));
      },
      answeringTargetsOf: (_runId: string) => [...answering],
    },
  };
};

const started = (targets: unknown): FakeEvent => ({ type: 'run.started', attempt: 1, now: 0, pins: { modelAlias: 'default', targets } });

const TARGETS = {
  opus: { adapter: 'anthropic', model: 'claude-opus', answers: 'model' },
  scripted: { adapter: 'chat-completions', model: 'fake-model', answers: 'script' },
  local: { adapter: 'ollama', model: 'llama3' },
};

const answeredBy = (events: FakeEvent[], answering: string[]) => answeredByOf(storeOf(events, answering).port as unknown as Parameters<typeof answeredByOf>[0], 'run-1');

describe('what answered a run, from the run_answerers record and its pins (decision 38 A)', () => {
  it('names each answering target of the record once, with the adapter, the upstream model and the pinned answers', () => {
    expect(answeredBy([started(TARGETS)], ['opus', 'scripted'])).toEqual([
      { target: 'opus', adapter: 'anthropic', upstreamModel: 'claude-opus', answers: 'model' },
      { target: 'scripted', adapter: 'chat-completions', upstreamModel: 'fake-model', answers: 'script' },
    ]);
  });

  it('reads run.started and the record only, never meter.observed or any other event type', () => {
    const store = storeOf([started(TARGETS)], ['scripted']);
    answeredByOf(store.port as unknown as Parameters<typeof answeredByOf>[0], 'run-1');
    expect(store.read).toEqual([['run.started']]);
  });

  it('reports a target the settings never declared as unknown, never as a model', () => {
    expect(answeredBy([started(TARGETS)], ['local'])).toEqual([{ target: 'local', adapter: 'ollama', upstreamModel: 'llama3', answers: 'unknown' }]);
  });

  it('reports the reserved unknown target of an answer recorded without a target as unknown, without looking it up in the pins', () => {
    expect(answeredBy([started({ opus: TARGETS.opus })], ['opus', 'unknown'])).toEqual([
      { target: 'opus', adapter: 'anthropic', upstreamModel: 'claude-opus', answers: 'model' },
      expect.objectContaining({ target: 'unknown', answers: 'unknown' }),
    ]);
  });

  it('answers with no target when the record holds none', () => {
    expect(answeredBy([started(TARGETS)], [])).toEqual([]);
  });

  it('refuses a run that pinned no targets instead of guessing what answered it', () => {
    expect(() => answeredBy([{ type: 'run.started', attempt: 1, now: 0, pins: { modelAlias: 'default' } }], ['opus'])).toThrow(/pinned no targets/);
  });

  it('refuses a recorded target that the pins do not list', () => {
    expect(() => answeredBy([started({ opus: TARGETS.opus })], ['ghost'])).toThrow(/ghost/);
  });
});
