import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HostExec } from '@momonga/foundation';
import * as runtime from '@momonga/runtime';
import { makeCache, makeDir, makeRuntimeFixture, writeUserSettings } from './helpers.ts';

const unanswered = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('@momonga/foundation', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/foundation')>();
  const neverAnswers: HostExec = (file) =>
    new Promise(() => {
      unanswered.calls.push(file);
    });
  return { ...original, createHostExec: () => neverAnswers };
});

const outcomeOf = (promise: Promise<unknown>): Promise<{ value: unknown } | { error: unknown }> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

const compositionWithAManagedClassifier = async (): Promise<{ composition: runtime.SettingsComposition; project: string }> => {
  const f = await makeRuntimeFixture();
  const binary = path.join(makeDir(f.temp.home, 'bin'), 'fm');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeUserSettings(f.temp.home, { autoMode: { classifier: 'system' }, models: { connections: [{ adapter: 'managed', server: 'fm', binary, models: [{ id: 'system', toolCalling: 'native' }] }] } });
  const composition = runtime.createSettingsComposition({ home: f.temp.home, platform: 'darwin', cache: makeCache(f.temp.home), store: f.store });
  return { composition, project: f.temp.project };
};

describe('the classifier key read of a session ends with the request that asked', () => {
  it.each(['sessionCreateSettings', 'sessionReadSettings'] as const)('%s rejects with the reason of its request when the request ends while the OS build is unanswered', async (ask) => {
    const { composition, project } = await compositionWithAManagedClassifier();
    const request = new AbortController();
    const ended = new Error('the request ended');
    const asked = unanswered.calls.length;

    const outcome = outcomeOf(composition[ask](project, request.signal));
    await vi.waitFor(() => expect(unanswered.calls.length).toBe(asked + 1));
    request.abort(ended);

    expect(await outcome).toEqual({ error: ended });
  });

  it('gives a second request its own wait on the reading the first request left', async () => {
    const { composition, project } = await compositionWithAManagedClassifier();
    const first = new AbortController();
    const second = new AbortController();
    const firstEnded = new Error('the first request ended');
    const secondEnded = new Error('the second request ended');
    const asked = unanswered.calls.length;

    const firstOutcome = outcomeOf(composition.sessionReadSettings(project, first.signal));
    await vi.waitFor(() => expect(unanswered.calls.length).toBe(asked + 1));
    const secondOutcome = outcomeOf(composition.sessionReadSettings(project, second.signal));
    first.abort(firstEnded);
    expect(await firstOutcome).toEqual({ error: firstEnded });
    let secondSettled = false;
    void secondOutcome.then(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    second.abort(secondEnded);
    expect(await secondOutcome).toEqual({ error: secondEnded });
  });
});
