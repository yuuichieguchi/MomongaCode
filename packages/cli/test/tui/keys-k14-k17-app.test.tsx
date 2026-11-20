import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlanModelsResponse } from '@momonga/protocol';
import { listedEntryOf, runView } from '../fake-backend.ts';
import { account } from '../fake-plan-gateway.tsx';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { PROBE, highlighted, hold, inputLineOf, shows, startAtRealTiming } from './keys-shown-screen.tsx';
import type { AtRealTiming } from './keys-shown-screen.tsx';
import { EFFORT_PICKER, LUNA, MODEL_LIST, QWEN, SIGNED_IN, toRow } from './keys-shown-screen-cases.tsx';
import { freshPlace, writeSettings } from './settings-harness.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const KITTY_ESCAPE = '\u001b[27u';
const PICKER = 'Add another account or workspace';
const GPT: PlanModelsResponse = { readAt: '2026-11-10T00:00:00.000Z', models: [{ slug: 'gpt-5.1', displayName: 'GPT-5.1', usable: true, contextWindow: 272000, maxOutputTokens: 128000 }] };
const USAGE_LIMIT = runView({ status: 'STOPPED', stopReason: 'usage_limit' as never, error: { code: 'plan_usage_limit', message: 'Manage usage', plan: { profile: 'chatgpt', account: 'chatgpt' } } as never });
const LIMIT_LIST = (frame: string): boolean => frame.includes('Manage usage') && frame.includes('Dismiss');

const cancels = (driver: AtRealTiming): string[] => driver.backend.calls.filter((call) => call.startsWith('cancel:'));

const working = async (extra: Parameters<typeof startAtRealTiming>[0] = SIGNED_IN): Promise<AtRealTiming> => {
  const driver = await startAtRealTiming(extra);
  await driver.submit('long task');
  await driver.until(() => driver.backend.started.length === 1, 'the run started');
  await driver.settled();
  return driver;
};

describe('K14: Esc stops one foreground operation at a time', () => {
  it('Esc, Esc during a kept wait: first Esc cancels the wait back to the list, second Esc closes the list', async () => {
    const driver = await startAtRealTiming(SIGNED_IN);
    await driver.submit('/model');
    await driver.untilShown(MODEL_LIST);
    await driver.settled();
    await toRow(driver, 'Model settings…');
    const held = hold(driver.backend, 'health');
    driver.app.stdin.write(KEYS.enter);
    await driver.untilShown('checking the servers');
    driver.oneWrite(`${KITTY_ESCAPE}${KITTY_ESCAPE}`);
    await driver.pause(500);
    expect(shows(MODEL_LIST)(driver.frameNow())).toBe(false);
    expect(driver.frameNow()).not.toContain('checking the servers');
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('>');
    held.release();
    await driver.pause(300);
    expect(shows(MODEL_LIST)(driver.frameNow())).toBe(false);
    driver.app.unmount();
  });

  it('Esc during a kept wait aborts the underlying AbortSignal of the read/write', async () => {
    const gate = Promise.withResolvers<void>();
    let aborted = false;
    const driver = await startAtRealTiming({
      options: {
        ...SIGNED_IN,
        detect: async (options) => {
          options.signal?.addEventListener('abort', () => {
            aborted = true;
          });
          await gate.promise;
          return [];
        },
      },
    });
    await driver.submit('/model');
    await driver.untilShown(MODEL_LIST);
    await driver.settled();
    await toRow(driver, 'Model settings…');
    await driver.step(KEYS.enter, 'Add a model');
    await toRow(driver, 'Add a model');
    await driver.step(KEYS.enter, 'Search this computer for model servers');
    await toRow(driver, 'Search this computer for model servers');
    driver.app.stdin.write(KEYS.enter);
    await driver.untilShown('searching for model servers');
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(200);
    expect(aborted).toBe(true);
    expect(driver.frameNow()).toContain('Search this computer for model servers');
    gate.resolve();
    driver.app.unmount();
  });

  it('Esc, Esc on an open list while a run is working: first Esc closes the list, second Esc stops the run', async () => {
    const driver = await working();
    await driver.submit('/mode');
    await driver.untilShown('Permission mode');
    await driver.settled();
    driver.oneWrite(`${KITTY_ESCAPE}${KITTY_ESCAPE}`);
    await driver.pause(500);
    expect(driver.frameNow()).not.toContain('Permission mode');
    expect(cancels(driver)).toEqual(['cancel:run-1']);
    driver.app.unmount();
  });

  it('Enter+Esc on the prompt starting a run while startRun is still pending stops that run once started', async () => {
    const driver = await startAtRealTiming(SIGNED_IN);
    const starting = hold(driver.backend, 'startRun');
    driver.app.stdin.write('hello');
    await driver.untilShown('> hello');
    driver.oneBatch(KEYS.enter);
    await driver.until(() => starting.calls() === 1, 'startRun called');
    starting.release();
    await driver.pause(500);
    expect(cancels(driver)).toEqual(['cancel:run-1']);
    driver.app.unmount();
  });

  it('Enter+Esc on the prompt queueing a follow-up while another run works withdraws the queued message without stopping the working run', async () => {
    const driver = await working();
    driver.app.stdin.write('queued task');
    await driver.untilShown('> queued task');
    driver.oneBatch(KEYS.tab);
    await driver.pause(500);
    expect(driver.backend.calls.some((call) => call.startsWith('inbox:queue:queued task'))).toBe(true);
    expect(driver.backend.calls.some((call) => call.startsWith('inbox-withdraw:'))).toBe(true);
    expect(cancels(driver)).toEqual([]);
    driver.app.unmount();
  });

  it('Esc while the agents list has focus and a run is working leaves agents focus without stopping the run; a second Esc stops the run', async () => {
    const driver = await working();
    driver.backend.following().onChildStarted('reviewer', 'child-1', 0, QWEN, undefined);
    await driver.untilShown('reviewer');
    driver.app.stdin.write(KEYS.down);
    await driver.pause(100);
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(200);
    expect(cancels(driver)).toEqual([]);
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(200);
    expect(cancels(driver)).toEqual(['cancel:run-1']);
    driver.app.unmount();
  });

  it('Esc arriving before an undrawn usage-limit panel over an open list does not dismiss the usage-limit panel and closes the list underneath', async () => {
    const driver = await working();
    await driver.submit('/mode');
    await driver.untilShown('Permission mode');
    await driver.settled();
    const originalWrite = driver.app.stdout.write;
    const pass = originalWrite as unknown as (chunk: string, cb?: () => void) => void;
    const heldFrames: [string, (() => void) | undefined][] = [];
    driver.app.stdout.write = ((chunk: string, cb?: () => void): void => {
      heldFrames.push([chunk, cb]);
    }) as typeof driver.app.stdout.write;
    driver.backend.finish(USAGE_LIMIT);
    await driver.pause(50);
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(50);
    driver.app.stdout.write = originalWrite;
    for (const [chunk, cb] of heldFrames.splice(0)) pass(chunk, cb);
    await driver.untilShown(LIMIT_LIST);
    await driver.pause(200);
    expect(LIMIT_LIST(driver.frameNow())).toBe(true);
    driver.app.stdin.write('2');
    await driver.pause(300);
    expect(LIMIT_LIST(driver.frameNow())).toBe(false);
    expect(driver.frameNow()).not.toContain('Permission mode');
    driver.app.unmount();
  });
});

describe('K15: /login account operations close the list on confirm and Esc stops the pending operation', () => {
  it('switch active account (even with no pinned models) closes the account list at once and Esc stops following up', async () => {
    const driver = await startAtRealTiming({
      ...SIGNED_IN,
      accounts: [account({ pinnedBy: [] }), account({ label: 'work', active: false, pinnedBy: [] })],
      catalogs: { work: GPT },
    });
    await driver.submit('/login chatgpt');
    await driver.untilShown(PICKER);
    await driver.settled();
    await toRow(driver, 'work');
    const held = hold(driver.backend.plan, 'setActive');
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(30);
    expect(held.calls()).toBe(1);
    expect(shows(PICKER)(driver.frameNow())).toBe(false);
    driver.app.stdin.write(PROBE);
    await driver.pause(30);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe(`> ${PROBE}`);
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(50);
    held.release();
    await driver.pause(300);
    expect(driver.frameNow()).not.toContain('gpt-5.1');
    driver.app.unmount();
  });

  it('rename account closes the screen on confirm and Esc stops waiting without stopping a working run', async () => {
    const place = freshPlace();
    fs.mkdirSync(path.dirname(place.userFile), { recursive: true, mode: 0o700 });
    writeSettings(place.userFile, { models: { connections: [{ adapter: 'open-responses', plan: { profile: 'chatgpt', account: 'work' }, models: [{ id: 'gpt-6-luna', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] }] } });
    const driver = await working({
      ...SIGNED_IN,
      accounts: [account({ label: 'work', pinnedBy: ['work/gpt-6-luna'] })],
      settingsPlace: { home: place.home, projectDir: place.project },
    });
    await driver.submit('/login chatgpt');
    await driver.untilShown(PICKER);
    await driver.settled();
    await toRow(driver, 'Rename account work');
    await driver.step(KEYS.enter, 'Rename account work');
    driver.app.stdin.write('\u007f'.repeat(4) + 'job');
    await driver.untilShown('> job');
    const held = hold(driver.backend.plan, 'rename');
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(30);
    expect(held.calls()).toBe(1);
    expect(driver.frameNow()).not.toContain('Rename account work');
    expect(shows(PICKER)(driver.frameNow())).toBe(false);
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(100);
    expect(cancels(driver)).toEqual([]);
    held.release();
    await driver.pause(300);
    expect(cancels(driver)).toEqual([]);
    driver.app.unmount();
  });

  it('remove account closes the screen on confirm and Esc stops waiting; Esc on confirm returns to the account list', async () => {
    const driver = await startAtRealTiming({
      ...SIGNED_IN,
      accounts: [account({ label: 'work', pinnedBy: [] })],
    });
    await driver.submit('/login chatgpt');
    await driver.untilShown(PICKER);
    await driver.settled();
    await toRow(driver, 'Remove account work');
    await driver.step(KEYS.enter, (frame) => frame.includes('Remove account work') && !frame.includes(PICKER));
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(200);
    expect(shows(PICKER)(driver.frameNow())).toBe(true);
    await toRow(driver, 'Remove account work');
    await driver.step(KEYS.enter, (frame) => frame.includes('Remove account work') && !frame.includes(PICKER));
    await driver.step(KEYS.enter, 'again to sign out work');
    const held = hold(driver.backend.plan, 'signOut');
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(30);
    expect(held.calls()).toBe(1);
    expect(driver.frameNow()).not.toContain('again to sign out work');
    expect(shows(PICKER)(driver.frameNow())).toBe(false);
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(50);
    held.release();
    await driver.pause(300);
    expect(driver.frameNow()).not.toContain('Signed out work');
    driver.app.unmount();
  });

  it('Resume plan use closes the account list on confirm and Esc stops waiting', async () => {
    const driver = await startAtRealTiming({
      ...SIGNED_IN,
      accounts: [account({ label: 'work', paused: { until: '2026-11-22T00:00:00.000Z' }, pinnedBy: [] })],
      catalogs: { work: GPT },
    });
    await driver.submit('/login chatgpt');
    await driver.untilShown(PICKER);
    await driver.settled();
    await toRow(driver, 'Resume plan use for work');
    const held = hold(driver.backend.plan, 'resume');
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(30);
    expect(held.calls()).toBe(1);
    expect(shows(PICKER)(driver.frameNow())).toBe(false);
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(50);
    held.release();
    await driver.pause(300);
    expect(driver.frameNow()).not.toContain('gpt-5.1');
    driver.app.unmount();
  });
});

describe('K17: /model reread cursor fallback when highlighted model disappears', () => {
  const openEffortOnLuna = async () => {
    const driver = await startAtRealTiming(SIGNED_IN);
    await driver.submit('/model');
    await driver.untilShown(MODEL_LIST);
    await driver.settled();
    await toRow(driver, 'gpt-6-luna');
    driver.app.stdin.write(KEYS.enter);
    await driver.untilShown(EFFORT_PICKER);
    await driver.settled();
    return driver;
  };

  it('moves cursor to the (current) model row when the highlighted model is gone', async () => {
    const driver = await openEffortOnLuna();
    const original = driver.backend.modelList.bind(driver.backend);
    const gate = Promise.withResolvers<void>();
    driver.backend.modelList = async () => {
      await gate.promise;
      const listed = await original();
      const kept = listed.data.filter((entry) => entry.id === QWEN);
      const first = kept[0]!;
      const member = first.chain[0]!;
      const extra = { ...listedEntryOf('ollama/aaa-first:latest', member.capabilities), billing: first.billing, capabilities: first.capabilities };
      return { ...listed, data: [extra, first] };
    };
    driver.app.stdin.write(KEYS.escape);
    await driver.untilShown(MODEL_LIST);
    gate.resolve();
    await driver.untilShown('aaa-first');
    expect(highlighted('qwen3.8:27b')(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });

  it('moves cursor to the first row when both the highlighted model and (current) are gone', async () => {
    const driver = await openEffortOnLuna();
    const original = driver.backend.modelList.bind(driver.backend);
    const gate = Promise.withResolvers<void>();
    driver.backend.modelList = async () => {
      await gate.promise;
      const listed = await original();
      const first = listed.data[0]!;
      const member = first.chain[0]!;
      const one = { ...listedEntryOf('ollama/aaa-only:latest', member.capabilities), billing: first.billing, capabilities: first.capabilities };
      const two = { ...listedEntryOf('ollama/bbb-second:latest', member.capabilities), billing: first.billing, capabilities: first.capabilities };
      return { ...listed, data: [one, two] };
    };
    driver.app.stdin.write(KEYS.escape);
    await driver.untilShown(MODEL_LIST);
    gate.resolve();
    await driver.untilShown('aaa-only');
    expect(highlighted('aaa-only')(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });
});

describe('K2-1 and K3-3 fixes: /effort closes immediately on save, and child field Esc returns to its immediate list', () => {
  it('/effort (saved scope) closes the picker immediately while saving the effort', async () => {
    const place = freshPlace();
    fs.mkdirSync(path.dirname(place.userFile), { recursive: true, mode: 0o700 });
    writeSettings(place.userFile, { models: { connections: [{ adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'qwen3.8:27b', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] }] } });
    const driver = await startAtRealTiming({ ...SIGNED_IN, settingsPlace: { home: place.home, projectDir: place.project } });
    await driver.submit('/effort');
    await driver.untilShown(EFFORT_PICKER);
    await driver.settled();
    await toRow(driver, 'high');
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(50);
    expect(EFFORT_PICKER(driver.frameNow())).toBe(false);
    driver.app.unmount();
  });

  it('Esc on a field inside Models hub -> model -> Edit returns to the model fields list, not the Models hub', async () => {
    const place = freshPlace();
    fs.mkdirSync(path.dirname(place.userFile), { recursive: true, mode: 0o700 });
    writeSettings(place.userFile, { models: { connections: [{ adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: [{ id: 'qwen3.8:27b', capabilities: { contextWindow: 32768, maxOutputTokens: 8192 } }] }] } });
    const driver = await startAtRealTiming({ ...SIGNED_IN, settingsPlace: { home: place.home, projectDir: place.project } });
    await driver.submit('/model');
    await driver.untilShown(MODEL_LIST);
    await driver.settled();
    await toRow(driver, 'Model settings…');
    await driver.step(KEYS.enter, 'Add a model');
    await toRow(driver, QWEN);
    await driver.step(KEYS.enter, '1. Edit');
    await toRow(driver, 'Edit');
    await driver.step(KEYS.enter, 'Context window');
    await toRow(driver, 'Context window');
    await driver.step(KEYS.enter, 'enter to confirm');
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(300);
    expect(driver.frameNow()).toContain('Context window');
    expect(driver.frameNow()).not.toContain('Add a model');
    driver.app.unmount();
  });

  it('Esc on Type another command in the project check question returns to the check list', async () => {
    const driver = await startAtRealTiming({
      options: { ...SIGNED_IN, checkProposal: { ask: true, checks: [{ command: 'npm test', source: 'package.json' }] } },
      ready: 'This folder declares a check',
    });
    await toRow(driver, 'Type another command');
    await driver.step(KEYS.enter, 'The check command for this folder');
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(300);
    expect(driver.frameNow()).toContain('This folder declares a check');
    expect(driver.frameNow()).not.toContain('The check command for this folder');
    driver.app.unmount();
  });
});
