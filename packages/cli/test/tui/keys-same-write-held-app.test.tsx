import { describe, expect, it, vi } from 'vitest';
import { KEY_SETTLE_MS } from '../../src/tui/terminal/constants.ts';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { highlighted, hold, shows, startAtRealTiming } from './keys-shown-screen.tsx';
import type { AtRealTiming, Shown } from './keys-shown-screen.tsx';
import { SIGNED_IN, endings, toRow, transitions } from './keys-shown-screen-cases.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

type EnterAndEsc = readonly [string, (driver: AtRealTiming, keys: string) => void];
const ENTER_AND_ESC_FORMS: readonly EnterAndEsc[] = [
  ['one write, the lone esc ended by the parser hold', (driver, keys) => driver.oneWrite(`${keys}${KEYS.escape}`)],
  ['one batch with esc as CSI 27u', (driver, keys) => driver.oneBatch(keys)],
];

const AFTER_THE_HOLD_MS = KEY_SETTLE_MS * 3;

const cancels = (driver: AtRealTiming): string[] => driver.backend.calls.filter((call) => call.startsWith('cancel:'));
const modeWrites = (driver: AtRealTiming): string[] => driver.backend.calls.filter((call) => call.startsWith('mode:'));

const shownAgainAfterClosing = (frames: readonly string[], list: Shown): boolean => {
  const closed = frames.findIndex((frame) => !shows(list)(frame));
  return closed !== -1 && frames.slice(closed).some(shows(list));
};

const modeEnding = () => {
  const found = endings().find((candidate) => candidate.flow === '/mode');
  if (found === undefined) throw new Error('no /mode ending');
  return found;
};

const THEME_INITIAL = { theme: 'auto', notify: 'off', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true };

const heldThemePort = () => {
  const gate = Promise.withResolvers<void>();
  const saves: string[] = [];
  const signals: AbortSignal[] = [];
  const port = {
    initial: THEME_INITIAL,
    save: async (name: string, value: unknown, signal: AbortSignal) => {
      saves.push(`${name}:${String(value)}`);
      signals.push(signal);
      await gate.promise;
    },
  };
  return { port, saves, aborted: () => signals.some((signal) => signal.aborted), release: () => gate.resolve() };
};

const THEME_LIST = (frame: string): boolean => frame.includes('Theme') && frame.includes('esc: go back');

describe('K14: enter and esc in one write on a row that saves and ends, the write held open past the esc', () => {
  for (const [form, press] of ENTER_AND_ESC_FORMS) {
    it(`${form}: /mode with no run working: the list closes at the choice, stays closed, esc stops waiting on the write, and cancels no run`, async () => {
      const mode = modeEnding();
      const driver = await startAtRealTiming(mode.given());
      await mode.reach(driver);
      const held = hold(driver.backend, 'setMode');
      const since = driver.mark();
      press(driver, KEYS.enter);
      await driver.pause(AFTER_THE_HOLD_MS);
      expect(held.calls()).toBe(1);
      expect(shows(mode.list)(driver.frameNow())).toBe(false);
      expect(shownAgainAfterClosing(since(), mode.list)).toBe(false);
      expect(cancels(driver)).toEqual([]);
      held.release();
      await driver.pause(500);
      expect(shownAgainAfterClosing(since(), mode.list)).toBe(false);
      expect(cancels(driver)).toEqual([]);
      driver.app.unmount();
    });

    it(`${form}: /mode while another run is working: the list closes, esc stops the write without stopping the working run, and a second esc stops the run`, async () => {
      const mode = modeEnding();
      const driver = await startAtRealTiming(mode.given());
      await driver.submit('long task');
      await driver.until(() => driver.backend.started.length === 1, 'the run started');
      await driver.settled();
      await mode.reach(driver);
      const held = hold(driver.backend, 'setMode');
      const since = driver.mark();
      press(driver, KEYS.enter);
      await driver.pause(AFTER_THE_HOLD_MS);
      expect(held.calls()).toBe(1);
      expect(shows(mode.list)(driver.frameNow())).toBe(false);
      expect(shownAgainAfterClosing(since(), mode.list)).toBe(false);
      expect(cancels(driver)).toEqual([]);
      driver.app.stdin.write(KEYS.escape);
      await driver.pause(300);
      expect(cancels(driver)).toHaveLength(1);
      held.release();
      await driver.pause(500);
      expect(shownAgainAfterClosing(since(), mode.list)).toBe(false);
      expect(cancels(driver)).toHaveLength(1);
      driver.app.unmount();
    });

    it(`${form}: /theme with no run working: the save is aborted by esc, no list comes back, and theme: dark is not printed`, async () => {
      const theme = heldThemePort();
      const driver = await startAtRealTiming({ options: SIGNED_IN, extra: { tuiSettings: theme.port as never } });
      await driver.submit('/theme');
      await driver.untilShown(THEME_LIST);
      await driver.settled();
      await toRow(driver, 'dark');
      const since = driver.mark();
      press(driver, KEYS.enter);
      await driver.pause(AFTER_THE_HOLD_MS);
      expect(theme.saves).toEqual(['theme:dark']);
      expect(theme.aborted()).toBe(true);
      expect(shows(THEME_LIST)(driver.frameNow())).toBe(false);
      expect(shownAgainAfterClosing(since(), THEME_LIST)).toBe(false);
      theme.release();
      await driver.pause(500);
      expect(theme.aborted()).toBe(true);
      expect(driver.frameNow()).not.toContain('theme: dark');
      expect(shownAgainAfterClosing(since(), THEME_LIST)).toBe(false);
      expect(cancels(driver)).toEqual([]);
      driver.app.unmount();
    });

    it(`${form}: /theme while another run is working: first esc aborts the save while the working run continues, second esc stops the run`, async () => {
      const theme = heldThemePort();
      const driver = await startAtRealTiming({ options: SIGNED_IN, extra: { tuiSettings: theme.port as never } });
      await driver.submit('long task');
      await driver.until(() => driver.backend.started.length === 1, 'the run started');
      await driver.settled();
      await driver.submit('/theme');
      await driver.untilShown(THEME_LIST);
      await driver.settled();
      await toRow(driver, 'dark');
      const since = driver.mark();
      press(driver, KEYS.enter);
      await driver.pause(AFTER_THE_HOLD_MS);
      expect(theme.saves).toEqual(['theme:dark']);
      expect(theme.aborted()).toBe(true);
      expect(cancels(driver)).toEqual([]);
      expect(shownAgainAfterClosing(since(), THEME_LIST)).toBe(false);
      driver.app.stdin.write(KEYS.escape);
      await driver.pause(300);
      expect(cancels(driver)).toHaveLength(1);
      theme.release();
      await driver.pause(500);
      expect(driver.frameNow()).not.toContain('theme: dark');
      expect(shownAgainAfterClosing(since(), THEME_LIST)).toBe(false);
      expect(cancels(driver)).toHaveLength(1);
      driver.app.unmount();
    });
  }
});

const READ_WAITS = ['Model settings… → the models hub, its listing read later', 'Search this computer → what the search found, the search read later'];

describe('K2-2 / K3-2 / K8-5: enter and esc in one write on a row whose next screen waits for a read that is held', () => {
  for (const [form, press] of ENTER_AND_ESC_FORMS)
    for (const transition of transitions.filter((candidate) => READ_WAITS.includes(candidate.step))) {
      it(`${form}: ${transition.step}: the esc leaves the wait back to the list, and the late read shows nothing and changes nothing`, async () => {
        const driver = await startAtRealTiming(await transition.given());
        await transition.reach(driver);
        const held = transition.holdOn?.(driver);
        if (held === undefined) throw new Error(`no hold for ${transition.step}`);
        press(driver, transition.go ?? KEYS.enter);
        await driver.pause(AFTER_THE_HOLD_MS);
        const back = driver.frameNow();
        expect(shows(transition.previous)(back)).toBe(true);
        expect(highlighted(transition.row)(back)).toBe(true);
        expect(shows(transition.next)(back)).toBe(false);
        const afterRelease = driver.mark();
        held.release();
        await driver.pause(500);
        expect(afterRelease().some(shows(transition.next))).toBe(false);
        expect(shows(transition.previous)(driver.frameNow())).toBe(true);
        expect(highlighted(transition.row)(driver.frameNow())).toBe(true);
        driver.app.unmount();
      });
    }
});

describe('K10 / K2-2: the esc of the same write as the enter never acts on a screen that appeared after it, even when the read ends before the esc is handled', () => {
  for (const [form, press] of ENTER_AND_ESC_FORMS)
    for (const transition of transitions.filter((candidate) => READ_WAITS.includes(candidate.step))) {
      it(`${form}: ${transition.step}, the read released ${KEY_SETTLE_MS / 3} ms after the write: either the wait was left back to the list with its row highlighted, or the next screen stands untouched`, async () => {
        const driver = await startAtRealTiming(await transition.given());
        await transition.reach(driver);
        const held = transition.holdOn?.(driver);
        if (held === undefined) throw new Error(`no hold for ${transition.step}`);
        press(driver, transition.go ?? KEYS.enter);
        await driver.pause(KEY_SETTLE_MS / 3);
        held.release();
        await driver.pause(500);
        const now = driver.frameNow();
        const leftTheWait = shows(transition.previous)(now) && highlighted(transition.row)(now) && !shows(transition.next)(now);
        const nextUntouched = shows(transition.next)(now);
        expect({ leftTheWait, nextUntouched, now }).toEqual(expect.objectContaining({ [leftTheWait ? 'leftTheWait' : 'nextUntouched']: true }));
        driver.app.unmount();
      });
    }
});
