import { describe, expect, it, vi } from 'vitest';
import type { ResolvedTuiSettings } from '@momonga/config';
import { systemTiming } from '@momonga/foundation';
import { bannerRows, TAIL_WAG_FRAMES, TAIL_WAG_MS } from '../../src/tui/startup.tsx';
import type { TuiSettingsPort } from '../../src/tui/screen/notify.ts';
import type { ScreenTimers } from '../../src/tui/screen/timers.ts';
import { displayWidth } from '../../src/tui/screen/wrap.ts';
import { TUI_TEST_TIMEOUT_MS, untilFrame, untilOutput } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { runStarted, start, startStillStarting } from '../tui-harness.tsx';
import { manualClock } from './screen-clock.ts';
import type { FakeScreenSize } from './screen-fakes.ts';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const STARTUP = { version: '1.2.3', home: '/Users/ada' };
const BODY_END = '╰─┬─╯';
const REST_TAIL = '╰─╮';
const SWUNG_TAIL = '╭─╯';

type Watched = { clock: ReturnType<typeof manualClock>; timers: ScreenTimers; scheduled(): number; live(): number };

const watched = (base?: ScreenTimers): Watched => {
  const clock = manualClock(5000);
  const under = base ?? clock.timers;
  let scheduled = 0;
  const live = new Set<unknown>();
  const timers: ScreenTimers = {
    setTimeout: (run, ms) => {
      if (ms !== TAIL_WAG_MS) return under.setTimeout(run, ms);
      scheduled += 1;
      const handle: unknown = under.setTimeout(() => {
        live.delete(handle);
        run();
      }, ms);
      live.add(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      live.delete(handle);
      under.clearTimeout(handle);
    },
  };
  return { clock, timers, scheduled: () => scheduled, live: () => live.size };
};

const settings = (given: Partial<ResolvedTuiSettings>): TuiSettingsPort => ({
  initial: { theme: 'auto', notify: 'off', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true, ...given },
  save: async () => undefined,
});

const tailOf = (frame: string): string => {
  const lines = frame.split('\n');
  const end = lines.findIndex((line) => line.includes(BODY_END));
  if (end === -1) throw new Error(`no figure in:\n${frame}`);
  return lines[end + 1] ?? '';
};

const swung = (frame: string): boolean => tailOf(frame).includes(SWUNG_TAIL) && !tailOf(frame).includes(REST_TAIL);
const resting = (frame: string): boolean => tailOf(frame).includes(REST_TAIL) && !tailOf(frame).includes(SWUNG_TAIL);

const launch = async (watch: Watched, screen: Partial<FakeScreenSize> = { columns: 100, rows: 40 }, tui: Partial<ResolvedTuiSettings> = {}) =>
  start({}, { startup: STARTUP, now: watch.clock.now, timers: watch.timers, tuiSettings: settings(tui) }, screen);

const stepTo = async (app: Instance, watch: Watched, pose: (frame: string) => boolean): Promise<string> => {
  watch.clock.advance(TAIL_WAG_MS);
  return untilFrame(app, (frame) => frame.includes(BODY_END) && pose(frame));
};

describe('the figure wags its tail at a fresh launch', () => {
  it('keeps the width and the rows of the figure in every pose and changes only the tail row', () => {
    const rows = bannerRows({ config: STARTUP, model: { kind: 'connected', name: 'scripted-model' }, cwd: '/Users/ada/p', notices: [], figure: true }, 80);
    const swungRows = rows.map((row) => row.swing ?? row);
    expect(swungRows).toHaveLength(rows.length);
    expect(swungRows.map((row) => displayWidth(row.text))).toEqual(rows.map((row) => displayWidth(row.text)));
    const changed = rows.filter((row, index) => row.text !== swungRows[index]?.text);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.text).toContain(REST_TAIL);
    expect(swungRows.find((row) => row.text.includes(SWUNG_TAIL))).toBeDefined();
  });

  it('swings the tail a fixed number of times, then rests for good with no timer left', async () => {
    const watch = watched();
    const { app } = await launch(watch);
    expect(resting(await untilFrame(app, BODY_END))).toBe(true);
    for (let frame = 1; frame <= TAIL_WAG_FRAMES; frame += 1) await stepTo(app, watch, frame % 2 === 1 ? swung : resting);
    expect(watch.live()).toBe(0);
    expect(watch.scheduled()).toBe(TAIL_WAG_FRAMES);
    const settled = app.frames.length;
    for (let step = 0; step < 10; step += 1) watch.clock.advance(TAIL_WAG_MS);
    await untilFrame(app, BODY_END);
    expect(app.frames.slice(settled).filter((frame) => frame.includes(BODY_END) && !resting(frame))).toEqual([]);
    expect(watch.scheduled()).toBe(TAIL_WAG_FRAMES);
    app.unmount();
  });

  it.each([
    ['reduced motion', { reducedMotion: true }],
    ['screen-reader mode', { screenReader: true }],
  ] as const)('stays at rest under %s and schedules no wag timer', async (_name, tui) => {
    const watch = watched(systemTiming);
    const { app } = await startStillStarting({}, { startup: STARTUP, timers: watch.timers, tuiSettings: settings(tui) }, { columns: 100, rows: 40 });
    await untilOutput(app, (output) => output.includes('MomongaCode v1.2.3') && output.includes('mode: manual'));
    expect(app.frames.filter((frame) => frame.includes(BODY_END) && !resting(frame))).toEqual([]);
    expect(watch.scheduled()).toBe(0);
    app.unmount();
  });

  it('schedules no wag timer when the width drops the figure', async () => {
    const watch = watched();
    const { app } = await launch(watch, { columns: 30, rows: 40 });
    const shown = await untilFrame(app, 'MomongaCode v1.2.3');
    expect(shown).not.toContain(BODY_END);
    expect(watch.scheduled()).toBe(0);
    app.unmount();
  });

  it('leaves no timer once the screen is unmounted mid-wag', async () => {
    const watch = watched();
    const { app } = await launch(watch);
    await untilFrame(app, BODY_END);
    await stepTo(app, watch, swung);
    expect(watch.live()).toBe(1);
    app.unmount();
    expect(watch.live()).toBe(0);
  });

  it('takes typing while it wags, and a message sent ends the wag and leaves the history at rest', async () => {
    const watch = watched();
    const { app, backend } = await launch(watch, { screen: 'scrollback', columns: 100, rows: 40 });
    await untilFrame(app, BODY_END);
    await stepTo(app, watch, swung);
    await runStarted(backend, app, 'hello');
    expect(watch.live()).toBe(0);
    const output = await untilOutput(app, '> hello');
    expect(resting(output.slice(output.lastIndexOf('MomongaCode v1.2.3')))).toBe(true);
    for (let step = 0; step < TAIL_WAG_FRAMES; step += 1) watch.clock.advance(TAIL_WAG_MS);
    expect(watch.scheduled()).toBe(2);
    app.unmount();
  });
});
