import { describe, expect, it, vi } from 'vitest';
import type { ResolvedTuiSettings } from '@momonga/config';
import { systemTiming } from '@momonga/foundation';
import type { LocalServerDetection } from '@momonga/protocol';
import type { TrustItemsView } from '@momonga/protocol';
import { App, STILL_STARTING_HINT } from '../../src/tui/app.tsx';
import { APPROVE_ROW, NOT_NOW_ROW } from '../../src/tui/project-items.ts';
import { DECLINE_CHECK_ROW } from '../../src/tui/project-check.ts';
import type { TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import { STARTING_TEXT } from '../../src/tui/screen/waiting-row.tsx';
import { fakeBackend } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { PLAN_TEST_TIMEOUT_MS, account, choose, startPlan, untilRow } from '../fake-plan-gateway.tsx';
import { KEYS, renderObservable, settleAtOnce, untilFrame } from '../ink-helpers.ts';
import { fakeScreenTerminal } from './screen-fakes.ts';
import type { FakeScreenSize } from './screen-fakes.ts';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const STARTUP = { version: '1.2.3', home: '/Users/ada' };
const VERSION = 'MomongaCode v1.2.3';
const CWD = '/work/project';
const INPUT_ROW = /^│ > /;
const FIGURE = '∩';
const WELCOME_TITLE = 'Connect a model to start';
const UNCONNECTED_FOOTER = 'no model connected · /login';
const REFUSED = '/work/project/.momonga/settings.json: Unexpected end of JSON input';
const GROUP = { matcher: 'Bash', hooks: [{ type: 'command' as const, command: './scripts/check.sh --fix' }] };
const PENDING_HOOK: TrustItemsView = { items: [{ kind: 'hook', event: 'PreToolUse', group: GROUP, digest: 'd1', source: '/work/project/.momonga/settings.json', change: { kind: 'new' } }], refused: [] };
const HOOK_ROWS = ['PreToolUse hook group', './scripts/check.sh --fix', APPROVE_ROW, NOT_NOW_ROW];
const NPM_TEST = { source: 'package.json', command: 'npm test' } as const;
const TALL: FakeScreenSize = { columns: 100, rows: 50 };

type Gate = { held: Promise<void>; entered: Promise<void>; enter(): void; release(): void };

const gate = (): Gate => {
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  return { held: held.promise, entered: entered.promise, enter: () => entered.resolve(), release: () => held.resolve() };
};

type Held = { boot?: boolean; autoMode?: boolean; displays?: boolean };

const settings = (given: Partial<ResolvedTuiSettings>): TuiSettingsPort => ({
  initial: { theme: 'auto', notify: 'off', screenReader: false, reducedMotion: true, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true, ...given },
  save: async () => undefined,
});

const launch = (options: FakeBackendOptions = {}, screen: FakeScreenSize = TALL, held: Held = {}, tui: Partial<ResolvedTuiSettings> = {}) => {
  const base = fakeBackend(options);
  const boot = gate();
  const autoMode = gate();
  const displays = gate();
  let modelReads = 0;
  const backend = {
    ...base,
    boot: async () => {
      boot.enter();
      if (held.boot === true) await boot.held;
      return base.boot();
    },
    autoModeAvailable: async () => {
      autoMode.enter();
      if (held.autoMode === true) await autoMode.held;
      return base.autoModeAvailable();
    },
    models: async () => {
      modelReads += 1;
      if (modelReads > 1) displays.enter();
      if (modelReads > 1 && held.displays === true) await displays.held;
      return base.models();
    },
  };
  const terminal = fakeScreenTerminal(screen);
  const app = renderObservable(
    <App backend={backend} terminal={terminal} initialMode={undefined} now={Date.now} timers={settleAtOnce(systemTiming)} startup={STARTUP} tuiSettings={settings({ screen: screen.screen ?? 'fullscreen', ...tui })} onExit={() => undefined} />,
  );
  const releaseAll = (): void => {
    boot.release();
    autoMode.release();
    displays.release();
  };
  return { app, backend: base, boot, autoMode, displays, releaseAll };
};

const rowsOf = (frame: string): string[] => frame.split('\n');

const rowIndexOf = (rows: readonly string[], text: string | RegExp): number => {
  const index = rows.findIndex((row) => (typeof text === 'string' ? row.includes(text) : text.test(row)));
  if (index === -1) throw new Error(`no row with ${String(text)} in:\n${rows.join('\n')}`);
  return index;
};

const bannerEndOf = (rows: readonly string[]): number => rows.findIndex((row, index) => index > rowIndexOf(rows, VERSION) && row.trimStart().startsWith('╰') && row.trimEnd().endsWith('╯'));

const blank = (row: string): boolean => !/[\w›>⠋…]/.test(row.replace(/[│╭╮╰╯─]/g, ''));

const blankRowsAfter = (rows: readonly string[], index: number): number => {
  let count = 0;
  while (index + 1 + count < rows.length && blank(rows[index + 1 + count] ?? '')) count += 1;
  return count;
};

const listAtBottomEdge = (frame: string, above?: string): boolean => {
  const rows = rowsOf(frame);
  return blankRowsAfter(rows, above === undefined ? bannerEndOf(rows) : rowIndexOf(rows, above)) >= 3;
};

const modelLinesOf = (frame: string): string[] =>
  frame.split('\n').flatMap((row) => {
    const at = row.indexOf('model:');
    return at === -1 ? [] : [row.slice(at).replace(/[\s│]+$/, '')];
  });

describe('the first frame written at launch holds the start screen together with the input box', () => {
  it.each([
    ['fullscreen', { ...TALL, screen: 'fullscreen' }],
    ['scrollback', { ...TALL, screen: 'scrollback' }],
  ] as const)('in %s, with the daemon not yet answering, the first frame has the version, the folder, no model line and the input box', async (_name, screen) => {
    const { app, boot, releaseAll } = launch({}, screen, { boot: true });
    await boot.entered;
    const first = app.frames.find((frame) => frame.trim() !== '') ?? '';
    expect(first).toBe(app.frames[0]);
    expect(first).toContain(VERSION);
    expect(first).toContain(CWD);
    expect(modelLinesOf(first)).toEqual([]);
    expect(first).toContain(STARTING_TEXT);
    expect(rowsOf(first).some((row) => INPUT_ROW.test(row))).toBe(true);
    expect(rowIndexOf(rowsOf(first), VERSION)).toBeLessThan(rowIndexOf(rowsOf(first), INPUT_ROW));
    expect(app.frames.every((frame) => frame.split(VERSION).length <= 2)).toBe(true);
    releaseAll();
    app.unmount();
  });

  it('in screen-reader mode the first frame has the version and the folder, and no model line', async () => {
    const { app, boot, releaseAll } = launch({}, { ...TALL, screen: 'scrollback' }, { boot: true }, { screenReader: true, screen: 'scrollback' });
    await boot.entered;
    const first = app.frames[0] ?? '';
    expect(first).toContain(VERSION);
    expect(first).toContain(CWD);
    expect(modelLinesOf(first)).toEqual([]);
    releaseAll();
    app.unmount();
  });

  it('draws the start screen once: after the session opens the one start screen shows the model', async () => {
    const { app } = launch({}, TALL);
    const ready = await untilFrame(app, (shown) => shown.includes('mode: manual') && shown.includes('model: '));
    expect(ready.split(VERSION)).toHaveLength(2);
    expect(rowIndexOf(rowsOf(ready), VERSION)).toBeLessThan(8);
    app.unmount();
  });
});

describe('the model line of the start screen follows the phase only', () => {
  it('while the session opens at launch and its auto-mode answer is held, the start screen is shown with no model line', async () => {
    const { app, backend, autoMode, releaseAll } = launch({}, TALL, { autoMode: true });
    await backend.called('openSession');
    await autoMode.entered;
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain(VERSION);
    expect(modelLinesOf(frame)).toEqual([]);
    releaseAll();
    const ready = await untilFrame(app, 'mode: manual');
    expect(modelLinesOf(ready)).toHaveLength(1);
    app.unmount();
  });

  it('while the session opens at launch and the model names are being read, the start screen is shown with no model line', async () => {
    const { app, displays, releaseAll } = launch({}, TALL, { displays: true });
    await displays.entered;
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain(VERSION);
    expect(modelLinesOf(frame)).toEqual([]);
    releaseAll();
    await untilFrame(app, 'mode: manual');
    app.unmount();
  });

  it('pin: connecting a local server from the welcome keeps "not connected" until the session is ready', async () => {
    const ADDRESS = 'http://127.0.0.1:11434';
    const ollama: LocalServerDetection = { kind: 'ollama', provider: 'ollama', address: ADDRESS, models: [{ id: 'llama3.2:latest', tools: 'yes', ceiling: 131072 }] };
    const { app, backend } = await startPlan({ models: [], accounts: [], detected: [ollama] }, { startup: STARTUP }, TALL);
    const autoMode = Promise.withResolvers<boolean>();
    const asked = Promise.withResolvers<void>();
    backend.autoModeAvailable = async () => {
      asked.resolve();
      return autoMode.promise;
    };
    await choose(app, 'Use a local server');
    await choose(app, `ollama  ·  ${ADDRESS}`);
    await choose(app, 'llama3.2');
    await untilFrame(app, 'Add ollama/llama3.2 to your settings?');
    await choose(app, 'Yes');
    await backend.called('openSession');
    await asked.promise;
    const frame = app.lastFrame() ?? '';
    expect(frame).toContain(VERSION);
    expect(modelLinesOf(frame)).toEqual(['model: not connected']);
    expect(app.frames.filter((shown) => shown.includes('llama3.2') && shown.includes('model: ollama'))).toEqual([]);
    autoMode.resolve(false);
    const ready = await untilFrame(app, (shown) => shown.includes('mode: manual') && shown.includes('model: ollama'));
    expect(ready.split(VERSION)).toHaveLength(2);
    app.unmount();
  });

  it('esc on the welcome shows the /login pointer in the same frame that the unconnected prompt appears', async () => {
    const { app } = await startPlan({ models: [], accounts: [] }, { startup: STARTUP }, TALL);
    await untilRow(app, 'Continue with ChatGPT');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (shown) => shown.includes(UNCONNECTED_FOOTER) && shown.includes('(use /login)'));
    const unconnected = app.frames.filter((shown) => shown.includes(UNCONNECTED_FOOTER) && shown.includes(VERSION));
    expect(unconnected.length).toBeGreaterThan(0);
    for (const shown of unconnected) expect(modelLinesOf(shown)).toEqual(['model: not connected  (use /login)']);
    app.unmount();
  });
});

describe('a launch-time list in the starting phase is drawn under the start screen', () => {
  it('the item approval comes directly after the start screen and the waiting row, not at the bottom edge', async () => {
    const { app } = launch({ trustItems: PENDING_HOOK }, TALL);
    const frame = await untilFrame(app, APPROVE_ROW);
    const rows = rowsOf(frame);
    const version = rowIndexOf(rows, VERSION);
    const end = bannerEndOf(rows);
    const waiting = rowIndexOf(rows, STARTING_TEXT);
    expect(version).toBeLessThan(8);
    expect(end).toBeGreaterThan(version);
    expect(waiting - end).toBeLessThanOrEqual(2);
    expect(rowIndexOf(rows, 'PreToolUse hook group')).toBeGreaterThan(waiting);
    expect(rowIndexOf(rows, 'PreToolUse hook group') - waiting).toBeLessThanOrEqual(3);
    expect(listAtBottomEdge(frame)).toBe(false);
    app.unmount();
  });

  it('the check question comes directly after the start screen and the waiting row', async () => {
    const { app } = launch({ checkProposal: { ask: true, checks: [NPM_TEST] } }, TALL);
    const frame = await untilFrame(app, DECLINE_CHECK_ROW);
    const rows = rowsOf(frame);
    const end = bannerEndOf(rows);
    const waiting = rowIndexOf(rows, STARTING_TEXT);
    expect(rowIndexOf(rows, VERSION)).toBeLessThan(8);
    expect(waiting - end).toBeLessThanOrEqual(2);
    expect(rowIndexOf(rows, DECLINE_CHECK_ROW)).toBeGreaterThan(waiting);
    app.unmount();
  });

  it('text typed before the list is kept on its line between the waiting row and the list', async () => {
    const { app, boot, releaseAll } = launch({ trustItems: PENDING_HOOK }, TALL, { boot: true });
    await boot.entered;
    app.stdin.write('draft text');
    await untilFrame(app, '> draft text');
    releaseAll();
    const frame = await untilFrame(app, APPROVE_ROW);
    const rows = rowsOf(frame);
    const end = bannerEndOf(rows);
    const waiting = rowIndexOf(rows, STARTING_TEXT);
    const draft = rowIndexOf(rows, 'draft text');
    expect(rowIndexOf(rows, VERSION)).toBeLessThan(end);
    expect(end).toBeLessThan(waiting);
    expect(waiting).toBeLessThan(draft);
    expect(draft).toBeLessThan(rowIndexOf(rows, 'PreToolUse hook group'));
    expect(waiting - end).toBeLessThanOrEqual(2);
    app.unmount();
  });

  it('with a refused settings warning before it, the list is at the bottom edge', async () => {
    const { app } = launch({ trustItems: { ...PENDING_HOOK, refused: [REFUSED] } }, TALL);
    const frame = await untilFrame(app, APPROVE_ROW);
    const rows = rowsOf(frame);
    expect(rowIndexOf(rows, VERSION)).toBeLessThan(rowIndexOf(rows, REFUSED));
    expect(listAtBottomEdge(frame, REFUSED)).toBe(true);
    app.unmount();
  });

  it('on a short terminal the figure is dropped first and every row of the list stays visible', async () => {
    const tall = launch({ trustItems: PENDING_HOOK }, TALL);
    const measuredFrame = await untilFrame(tall.app, APPROVE_ROW);
    tall.app.unmount();
    expect(measuredFrame).toContain(FIGURE);
    const measured = rowsOf(measuredFrame);
    const needed = rowIndexOf(measured, NOT_NOW_ROW) + 1;
    const { app } = launch({ trustItems: PENDING_HOOK }, { columns: 100, rows: needed - 3 });
    const frame = await untilFrame(app, APPROVE_ROW);
    expect(frame).toContain(VERSION);
    expect(frame).not.toContain(FIGURE);
    for (const row of HOOK_ROWS) expect(frame).toContain(row);
    app.unmount();
  });

  it('after the answer the input box is at the bottom and the start screen is still first', async () => {
    const { app, backend } = launch({ trustItems: PENDING_HOOK }, TALL);
    expect(await untilFrame(app, APPROVE_ROW)).toContain(VERSION);
    app.stdin.write(KEYS.enter);
    await backend.called('openSession');
    const frame = await untilFrame(app, 'mode: manual');
    const rows = rowsOf(frame);
    expect(rowIndexOf(rows, VERSION)).toBeLessThan(8);
    expect(rowIndexOf(rows, INPUT_ROW)).toBeGreaterThan(rows.length - 8);
    expect(frame.split(VERSION)).toHaveLength(2);
    app.unmount();
  });

  it('a picker in the ready phase is at the bottom edge', async () => {
    const { app } = launch({}, TALL);
    await untilFrame(app, 'mode: manual');
    app.stdin.write('/model');
    await untilFrame(app, '> /model');
    app.stdin.write(KEYS.enter);
    const frame = await untilFrame(app, (shown) => /^\W*1\. /m.test(shown.replace(/│/g, ' ')) && !shown.includes('mode: manual (shift+tab)'));
    expect(listAtBottomEdge(frame)).toBe(true);
    app.unmount();
  });

  it('a picker in the unconnected phase is at the bottom edge', async () => {
    const catalog = { readAt: '2026-11-10T00:00:00.000Z', models: [{ slug: 'gpt-5.1', displayName: 'GPT-5.1', usable: true as const, contextWindow: 272000, maxOutputTokens: 128000 }] };
    const { app } = await startPlan({ models: [], accounts: [account()], catalogs: { chatgpt: catalog } }, { startup: STARTUP }, TALL);
    const frame = await untilFrame(app, (shown) => shown.includes('(use /login)') && shown.includes('GPT-5.1'));
    expect(listAtBottomEdge(frame)).toBe(true);
    app.unmount();
  });
});

describe('scrollback mode settles nothing before the start screen has its model line', () => {
  it('with a refused warning while the session opens, the start screen is written first, once, with its model line, then the warning', async () => {
    const { app, autoMode, releaseAll } = launch({ trustItems: { items: [], refused: [REFUSED] } }, { columns: 100, rows: 30, screen: 'scrollback' }, { autoMode: true });
    await autoMode.entered;
    const held = app.lastFrame() ?? '';
    expect(held).toContain(VERSION);
    expect(held.indexOf(VERSION)).toBeLessThan(held.indexOf(REFUSED));
    expect(app.frames.filter((frame) => frame.includes(REFUSED) && !frame.includes(VERSION))).toEqual([]);
    releaseAll();
    await untilFrame(app, 'mode: manual');
    const output = app.frames.join('\n');
    const withModel = app.frames.filter((frame) => frame.includes(VERSION) && modelLinesOf(frame).length === 1);
    expect(withModel.length).toBeGreaterThan(0);
    expect(output.indexOf(VERSION)).toBeLessThan(output.indexOf(REFUSED));
    expect(app.frames.filter((frame) => frame.includes(VERSION) && frame.endsWith('\n') && modelLinesOf(frame).length === 0)).toEqual([]);
    app.unmount();
  });
});

describe('what the approved change leaves as it is', () => {
  it('Enter while starting keeps the text and says that it is still starting', async () => {
    const { app, boot, releaseAll } = launch({}, TALL, { boot: true });
    await boot.entered;
    app.stdin.write('hello');
    await untilFrame(app, '> hello');
    app.stdin.write(KEYS.enter);
    const frame = await untilFrame(app, STILL_STARTING_HINT);
    expect(frame).toContain('> hello');
    expect(frame).toContain(STARTING_TEXT);
    releaseAll();
    app.unmount();
  });

  it('Enter while starting shows the start screen above the hint', async () => {
    const { app, boot, releaseAll } = launch({}, TALL, { boot: true });
    await boot.entered;
    app.stdin.write('hello');
    await untilFrame(app, '> hello');
    app.stdin.write(KEYS.enter);
    const frame = await untilFrame(app, STILL_STARTING_HINT);
    expect(frame).toContain(VERSION);
    releaseAll();
    app.unmount();
  });

  it('/clear while unconnected leaves no start screen', async () => {
    const { app } = await startPlan({ models: [], accounts: [] }, { startup: STARTUP }, TALL);
    await untilRow(app, 'Continue with ChatGPT');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, (shown) => shown.includes(UNCONNECTED_FOOTER) && shown.includes('(use /login)') && shown.split('\n').some((row) => INPUT_ROW.test(row)));
    app.stdin.write('/clear');
    await untilFrame(app, '> /clear');
    app.stdin.write(KEYS.enter);
    const cleared = await untilFrame(app, (shown) => !shown.includes(VERSION) && shown.includes(UNCONNECTED_FOOTER));
    expect(modelLinesOf(cleared)).toEqual([]);
    app.unmount();
  });
});
