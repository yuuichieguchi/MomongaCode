import { EVERY_REASONING_IS_OWN } from './own-reasoning.ts';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@momonga/foundation';
import { createReplayAdapter } from './support/replay-adapter.ts';
import type { AdapterRequest, ProviderAdapter } from '@momonga/gateway';
import type { StreamEvent } from '@momonga/protocol';
import { DEFAULT_SCRIPTED_CAPABILITIES, createScriptedAdapter, textResponseEvents } from '@momonga/testkit';
import { makeDir, userInput } from './gateway-helpers.ts';

const target = { name: 'primary', display: 'primary', model: 'scripted-primary' };
const ctx = () => ({ signal: new AbortController().signal, target, attempt: 1, reasoningOrigin: EVERY_REASONING_IS_OWN, capabilities: DEFAULT_SCRIPTED_CAPABILITIES });
const requestA: AdapterRequest = { model: 'scripted-primary', input: userInput('first') };
const requestB: AdapterRequest = { model: 'scripted-primary', input: userInput('second') };
const eventsA = textResponseEvents({ model: 'scripted-primary', chunks: ['alpha'] });
const eventsB = textResponseEvents({ model: 'scripted-primary', chunks: ['beta'] });

const collect = async (adapter: ProviderAdapter, request: AdapterRequest): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of adapter.create(request, ctx())) events.push(event);
  return events;
};

const failureOf = async (adapter: ProviderAdapter, request: AdapterRequest): Promise<unknown> =>
  collect(adapter, request).then(
    () => {
      throw new Error('expected the replay to fail');
    },
    (error: unknown) => error,
  );

const record = async (file: string): Promise<void> => {
  const inner = createScriptedAdapter({ calls: [{ events: eventsA }, { events: eventsB }] });
  const recorder = createReplayAdapter({ path: file, mode: 'record', inner });
  expect(await collect(recorder, requestA)).toEqual(eventsA);
  expect(await collect(recorder, requestB)).toEqual(eventsB);
  expect(inner.calls).toHaveLength(2);
};

describe('createReplayAdapter', () => {
  it('records each call through inner as one canonical JSONL line in a 0600 file', async () => {
    const file = path.join(makeDir(), 'replay.jsonl');
    await record(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    expect(lines.at(-1)).toBe('');
    const entries = lines.slice(0, -1);
    expect(entries).toHaveLength(2);
    for (const line of entries) expect(canonicalJson(JSON.parse(line))).toBe(line);
  });

  it('appends to an existing recording instead of truncating it', async () => {
    const file = path.join(makeDir(), 'replay.jsonl');
    await record(file);
    const inner = createScriptedAdapter({ calls: [{ events: eventsA }] });
    await collect(createReplayAdapter({ path: file, mode: 'record', inner }), requestA);
    expect(fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')).toHaveLength(3);
  });

  it('replays recorded entries in order in strict mode without an inner adapter', async () => {
    const file = path.join(makeDir(), 'replay.jsonl');
    await record(file);
    const replay = createReplayAdapter({ path: file, mode: 'strict' });
    expect(await collect(replay, requestA)).toEqual(eventsA);
    expect(await collect(replay, requestB)).toEqual(eventsB);
  });

  it('fails with model_error replay_mismatch when the request digest differs from the next entry', async () => {
    const file = path.join(makeDir(), 'replay.jsonl');
    await record(file);
    const replay = createReplayAdapter({ path: file, mode: 'strict' });
    const error = await failureOf(replay, requestB);
    const classified = replay.classify(error);
    expect(classified.retryable).toBe(false);
    expect(classified.error.type).toBe('model_error');
    expect(classified.error.code).toBe('replay_mismatch');
    expect(classified.error.message).toMatch(/digest/);
  });

  it('fails with replay_mismatch when calls exceed the recording', async () => {
    const file = path.join(makeDir(), 'replay.jsonl');
    await record(file);
    const replay = createReplayAdapter({ path: file, mode: 'strict' });
    await collect(replay, requestA);
    await collect(replay, requestB);
    const error = await failureOf(replay, requestA);
    expect(replay.classify(error).error.code).toBe('replay_mismatch');
  });

  it('rejects record mode without inner and strict mode on a missing file with clear messages', () => {
    const dir = makeDir();
    expect(() => createReplayAdapter({ path: path.join(dir, 'r.jsonl'), mode: 'record' })).toThrow(/inner/);
    expect(() => createReplayAdapter({ path: path.join(dir, 'missing.jsonl'), mode: 'strict' })).toThrow(/missing\.jsonl/);
  });
});
