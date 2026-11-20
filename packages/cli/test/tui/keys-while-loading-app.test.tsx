import { describe, expect, it, vi } from 'vitest';
import { PLAN_TEST_TIMEOUT_MS, startPlan } from '../fake-plan-gateway.tsx';
import type { FakePlanBackend } from '../fake-plan-gateway.tsx';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const READING = 'reading…';
const DEVSTRAL = 'ollama/devstral-small-2:latest';
const QWEN = 'ollama/qwen3.8:27b';
const LIST = 'a change applies from the next run';

const inputLineOf = (frame: string): string | undefined => frame.split('\n').map((row) => row.replace(/^│ /, '').replace(/\s*│$/, '')).find((row) => row.startsWith('> '));

const loadingModels = async () => {
  const started = await startPlan({ models: [DEVSTRAL, QWEN], accounts: [], dismissed: { 'invite:chatgpt': 'x' } });
  await started.backend.called('openSession');
  await untilFrame(started.app, 'mode: manual');
  const held = Promise.withResolvers<void>();
  const accounts = started.backend.plan.accounts;
  started.backend.plan.accounts = async (...given: Parameters<FakePlanBackend['plan']['accounts']>) => {
    await held.promise;
    return accounts(...given);
  };
  started.app.stdin.write('/model');
  await untilFrame(started.app, '> /model');
  return { ...started, release: held.resolve };
};

const typedWhileLoading = async (app: Instance, release: () => void, typed: string): Promise<void> => {
  app.stdin.write(`${KEYS.enter}${typed}`);
  await untilFrame(app, READING);
  release();
  const list = await untilFrame(app, (shown) => shown.includes(LIST) && !shown.includes(READING));
  expect(list).toContain('› 1.');
  app.stdin.write(KEYS.escape);
  const closed = await untilFrame(app, (shown) => !shown.includes(LIST) && shown.includes('mode: manual'));
  expect(inputLineOf(closed)?.trimEnd()).toBe('>');
};

describe('a key typed while a list is loading is dropped: it never reaches the draft and is never applied to the list', () => {
  for (const [name, typed] of [
    ['a digit', '2'],
    ['a letter', 'x'],
    ['several characters', 'abc'],
  ] as const) {
    it(`${name} typed in the same write as the enter of /model is dropped`, async () => {
      const { app, release } = await loadingModels();
      await typedWhileLoading(app, release, typed);
      app.unmount();
    });
  }

  it('the Models loading overlay shows its title and the reading hint', async () => {
    const { app, release } = await loadingModels();
    app.stdin.write(KEYS.enter);
    const shown = await untilFrame(app, READING);
    const rows = shown.split('\n').map((row) => row.trimEnd());
    const start = rows.indexOf('Models');
    expect(rows.slice(start, start + 2).join('\n')).toBe(['Models', 'reading… · esc cancels'].join('\n'));
    release();
    app.unmount();
  });

  it('esc during loading still cancels the list and is not put in the draft', async () => {
    const { app, release } = await loadingModels();
    app.stdin.write(KEYS.enter);
    await untilFrame(app, READING);
    app.stdin.write(KEYS.escape);
    const closed = await untilFrame(app, (shown) => !shown.includes(READING) && shown.includes('mode: manual'));
    release();
    expect(closed).not.toContain(LIST);
    expect(inputLineOf(closed) ?? '>').toBe('>'.padEnd((inputLineOf(closed) ?? '>').length, ' '));
    app.unmount();
  });
});
