import { describe, expect, it, vi } from 'vitest';
import type { ResolvedTuiSettings } from '@momonga/config';
import { systemTiming } from '@momonga/foundation';
import type { LocalServerDetection } from '@momonga/protocol';
import { SCRIPTED_MODEL } from '@momonga/testkit';
import { App } from '../../src/tui/app.tsx';
import type { TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import { fakeBackend } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { PLAN_TEST_TIMEOUT_MS, choose, startPlan, untilRow } from '../fake-plan-gateway.tsx';
import { KEYS, renderObservable, settleAtOnce, untilFrame } from '../ink-helpers.ts';
import { fakeScreenTerminal } from './screen-fakes.ts';
import type { FakeScreenSize } from './screen-fakes.ts';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const STARTUP = { version: '1.2.3', home: '/Users/ada' };
const VERSION = 'MomongaCode v1.2.3';
const CWD = '/work/project';
const FIGURE = '∩';
const OTHER = 'scripted/other-model';
const REASONING = { control: 'reasoning_effort', lowest: 'low' } as const;
const DECLARED: FakeBackendOptions['reasoning'] = { [SCRIPTED_MODEL]: REASONING, [OTHER]: REASONING };
const EFFORT = 'effort: medium';
const TRUST_ROW = '1. Yes, I trust this folder';
const WELCOME_TITLE = 'Connect a model to start';
const UNCONNECTED_FOOTER = 'no model connected · /login';
const TALL: FakeScreenSize = { columns: 100, rows: 50 };
const NARROW: FakeScreenSize = { columns: 36, rows: 50 };

const settings = (given: Partial<ResolvedTuiSettings>): TuiSettingsPort => ({
  initial: { theme: 'auto', notify: 'off', screenReader: false, reducedMotion: true, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true, ...given },
  save: async () => undefined,
});

const launch = (options: FakeBackendOptions, screen: FakeScreenSize, tui: Partial<ResolvedTuiSettings> = {}) => {
  const base = fakeBackend(options);
  const bootHeld = Promise.withResolvers<void>();
  const bootEntered = Promise.withResolvers<void>();
  const backend = {
    ...base,
    boot: async () => {
      bootEntered.resolve();
      await bootHeld.promise;
      return base.boot();
    },
  };
  const app = renderObservable(
    <App backend={backend} terminal={fakeScreenTerminal(screen)} initialMode={undefined} now={Date.now} timers={settleAtOnce(systemTiming)} startup={STARTUP} tuiSettings={settings({ screen: screen.screen ?? 'fullscreen', ...tui })} onExit={() => undefined} />,
  );
  return { app, backend: base, bootEntered: bootEntered.promise, releaseBoot: () => bootHeld.resolve() };
};

type Header = { version: number; model: number | undefined; effort: number | undefined; folder: number };

const headerOf = (frame: string): Header | undefined => {
  const rows = frame.split('\n');
  const version = rows.findIndex((row) => row.includes(VERSION));
  if (version === -1) return undefined;
  const folder = rows.findIndex((row, index) => index > version && row.includes(CWD) && !row.includes('trust'));
  if (folder === -1) return undefined;
  const between = (text: string): number | undefined => {
    const at = rows.slice(version + 1, folder).findIndex((row) => row.includes(text));
    return at === -1 ? undefined : version + 1 + at;
  };
  return { version, model: between('model:'), effort: between('effort:'), folder };
};

const modelRowOf = (frame: string): string => {
  const model = headerOf(frame)?.model;
  return model === undefined ? '' : (frame.split('\n')[model] ?? '');
};

const distinct = (values: readonly (number | undefined)[]): number[] => [...new Set(values.filter((value): value is number => value !== undefined))];

const headersOf = (frames: readonly string[]): Header[] => {
  const first = frames.findIndex((frame) => frame.includes(VERSION));
  expect(first).toBeGreaterThanOrEqual(0);
  const shown = frames.slice(first);
  const headers = shown.map(headerOf);
  expect(headers.filter((header) => header === undefined)).toEqual([]);
  return headers as Header[];
};

const expectFixedRows = (frames: readonly string[], seen: { effort: boolean } = { effort: true }): void => {
  const headers = headersOf(frames);
  expect(headers.length).toBeGreaterThan(0);
  expect(distinct(headers.map((header) => header.version))).toHaveLength(1);
  expect(distinct(headers.map((header) => header.folder))).toHaveLength(1);
  expect(headers.map((header) => header.folder - header.version)).toEqual(headers.map(() => 3));
  expect(distinct(headers.map((header) => header.model)).map((row) => row - (headers[0]?.version ?? 0))).toEqual([1]);
  if (seen.effort) expect(distinct(headers.map((header) => header.effort)).map((row) => row - (headers[0]?.version ?? 0))).toEqual([2]);
};

const expectPhasesSeen = (frames: readonly string[]): void => {
  const headers = headersOf(frames);
  expect(headers.some((header) => header.model === undefined)).toBe(true);
  expect(headers.some((header) => header.model !== undefined && header.effort === undefined)).toBe(true);
  expect(headers.some((header) => header.effort !== undefined)).toBe(true);
};

const runToEffort = async (screen: FakeScreenSize, tui: Partial<ResolvedTuiSettings> = {}): Promise<string[]> => {
  const capabilities = Promise.withResolvers<void>();
  const { app, bootEntered, releaseBoot } = launch({ reasoning: DECLARED, probing: [SCRIPTED_MODEL], modelPending: capabilities.promise }, screen, tui);
  await bootEntered;
  expect(app.frames[0] ?? '').toContain(VERSION);
  releaseBoot();
  const ready = await untilFrame(app, (shown) => shown.includes('model: scripted-model') && shown.includes('mode: manual'));
  expect(ready).not.toContain('effort:');
  capabilities.resolve();
  await untilFrame(app, EFFORT);
  const frames = [...app.frames];
  app.unmount();
  return frames;
};

describe('the four text rows of the start screen keep their places from the first frame to the effort line', () => {
  it.each([
    ['fullscreen', { ...TALL, screen: 'fullscreen' }, {}],
    ['scrollback', { ...TALL, screen: 'scrollback' }, {}],
    ['a narrow width without the figure', { ...NARROW, screen: 'fullscreen' }, {}],
    ['screen-reader mode', { ...TALL, screen: 'scrollback' }, { screenReader: true, screen: 'scrollback' }],
  ] as const)('in %s the version, model, effort and folder rows never move', async (_name, screen, tui) => {
    const frames = await runToEffort(screen, tui);
    expectPhasesSeen(frames);
    expectFixedRows(frames);
  });

  it('pin: at the narrow width no frame draws the figure', async () => {
    const frames = await runToEffort({ ...NARROW, screen: 'fullscreen' });
    expect(frames.filter((frame) => frame.includes(FIGURE))).toEqual([]);
  });
});

describe('the four text rows keep their places through the other launch paths', () => {
  it('through the folder trust question to ready', async () => {
    const capabilities = Promise.withResolvers<void>();
    const { app, releaseBoot } = launch({ reasoning: DECLARED, probing: [SCRIPTED_MODEL], modelPending: capabilities.promise, trust: { path: CWD, decision: null } }, TALL);
    releaseBoot();
    const asked = await untilFrame(app, (shown) => shown.includes(TRUST_ROW) && shown.includes(VERSION));
    expect(asked).not.toContain('model:');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, (shown) => shown.includes('model: scripted-model') && shown.includes('mode: manual'));
    capabilities.resolve();
    await untilFrame(app, EFFORT);
    expectPhasesSeen(app.frames);
    expectFixedRows(app.frames);
    app.unmount();
  });

  it('through the welcome to unconnected with esc', async () => {
    const { app } = await startPlan({ models: [], accounts: [] }, { startup: STARTUP }, TALL);
    await untilRow(app, 'Continue with ChatGPT');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (shown) => shown.includes(UNCONNECTED_FOOTER) && shown.includes('(use /login)'));
    expect(app.frames.some((shown) => shown.includes(WELCOME_TITLE) && shown.includes('model: not connected'))).toBe(true);
    expectFixedRows(app.frames, { effort: false });
    expect(headersOf(app.frames).filter((header) => header.effort !== undefined)).toEqual([]);
    app.unmount();
  });

  it('through the welcome to ready with a local server', async () => {
    const ADDRESS = 'http://127.0.0.1:11434';
    const ollama: LocalServerDetection = { kind: 'ollama', provider: 'ollama', address: ADDRESS, models: [{ id: 'llama3.2:latest', tools: 'yes', ceiling: 131072 }] };
    const { app } = await startPlan({ models: [], accounts: [], detected: [ollama] }, { startup: STARTUP }, TALL);
    await choose(app, 'Use a local server');
    await choose(app, `ollama  ·  ${ADDRESS}`);
    await choose(app, 'llama3.2');
    await untilFrame(app, 'Add ollama/llama3.2 to your settings?');
    await choose(app, 'Yes');
    await untilFrame(app, (shown) => shown.includes('mode: manual') && shown.includes('model: ollama') && shown.includes('effort:'));
    expectFixedRows(app.frames);
    app.unmount();
  });
});

describe('/model to a model whose capabilities are not read yet', () => {
  it('keeps the folder row, blanks the effort row, then draws the effort line on the same row', async () => {
    const capabilities = Promise.withResolvers<void>();
    const { app, releaseBoot } = launch({ reasoning: DECLARED, models: [SCRIPTED_MODEL, OTHER], probing: [OTHER], modelPending: capabilities.promise }, TALL);
    releaseBoot();
    const ready = await untilFrame(app, (shown) => shown.includes('model: scripted-model') && shown.includes(EFFORT) && shown.includes('mode: manual'));
    const before = headerOf(ready);
    expect(before?.effort).toBe((before?.version ?? 0) + 2);
    const switchedFrom = app.frames.length;
    app.stdin.write('/model other-model');
    await untilFrame(app, '> /model other-model');
    app.stdin.write(KEYS.enter);
    const switched = await untilFrame(app, (shown) => modelRowOf(shown).includes('model: other-model'));
    const blankEffort = headerOf(switched);
    expect(blankEffort?.folder).toBe(before?.folder);
    expect(blankEffort?.effort).toBeUndefined();
    expect(switched.split('\n')[(before?.version ?? 0) + 2]).not.toContain('effort:');
    capabilities.resolve();
    const after = await untilFrame(app, (shown) => headerOf(shown)?.effort !== undefined && modelRowOf(shown).includes('model: other-model'));
    expect(headerOf(after)).toEqual(before);
    const frames = app.frames.slice(switchedFrom);
    expect(distinct(frames.map((frame) => headerOf(frame)?.folder))).toEqual([before?.folder]);
    expect(distinct(frames.map((frame) => headerOf(frame)?.effort))).toEqual([before?.effort]);
    app.unmount();
  });
});
