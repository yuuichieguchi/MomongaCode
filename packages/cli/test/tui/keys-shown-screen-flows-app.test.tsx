import { describe, expect, it, vi } from 'vitest';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { NOTHING_HELD, PROBE, hold, highlighted, inputLineOf, screenHead, shownLines, shows, startAtRealTiming } from './keys-shown-screen.tsx';
import type { AtRealTiming } from './keys-shown-screen.tsx';
import { SECOND_ENTER, transitions } from './keys-shown-screen-cases.tsx';
import type { Transition } from './keys-shown-screen-cases.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const HISTORY_ROW = 'a history row → the prompt holds it';
const FORGET_ROW = 'a text setting (Forget after (days)) → its text field';
const OWN_PINS: readonly string[] = [HISTORY_ROW, FORGET_ROW];

const opened = async (transition: Transition) => {
  const driver = await startAtRealTiming(await transition.given());
  await transition.reach(driver);
  const held = transition.holdOn?.(driver) ?? NOTHING_HELD;
  return { driver, held };
};

const go = (driver: AtRealTiming, transition: Transition): void => {
  driver.app.stdin.write(transition.go ?? KEYS.enter);
};

const leave = async (driver: AtRealTiming): Promise<void> => {
  for (let step = 0; step < 6 && !driver.frameNow().includes('mode: manual'); step += 1) {
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(300);
  }
  for (let step = 0; step < 6 && inputLineOf(driver.frameNow()).trimEnd() !== '>' && /esc: go back|esc: Cancel|enter to confirm/.test(driver.frameNow()); step += 1) {
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(300);
  }
};

describe('between two screens of a flow, the screen showing stays until the next one replaces it, and a key acts only on the screen showing', () => {
  for (const transition of transitions) {
    describe(`${transition.flow}: ${transition.step}`, () => {
      const waitScreen = transition.waitScreen;
      if (waitScreen !== undefined)
        it(`1: while the step waits the screen shows "${waitScreen[0]}" and "${waitScreen[1]}" in place of the list, and no frame shows the bare prompt or the bare wait row`, async () => {
          const { driver, held } = await opened(transition);
          const since = driver.mark();
          go(driver, transition);
          await driver.pause(100);
          expect(shownLines(driver.frameNow())).toEqual([...waitScreen]);
          held.release();
          await driver.untilShown(transition.next);
          const isWait = (frame: string): boolean => JSON.stringify(shownLines(frame)) === JSON.stringify(waitScreen);
          const screens = [transition.previous, ...(transition.between ?? []), transition.next].map(shows);
          expect(since().filter((frame) => !isWait(frame) && !screens.some((screen) => screen(frame)))).toEqual([]);
          driver.app.unmount();
        });
      if (waitScreen === undefined) it('1: no frame between the two screens shows the bare prompt', async () => {
        const { driver, held } = await opened(transition);
        const since = driver.mark();
        go(driver, transition);
        await driver.pause(100);
        held.release();
        await driver.untilShown(transition.next);
        const screens = [transition.previous, ...(transition.between ?? []), transition.next].map(shows);
        expect(since().filter((frame) => !screens.some((screen) => screen(frame)))).toEqual([]);
        driver.app.unmount();
      });

      if (transition.holdOn !== undefined) it('2: characters, digits and enter pressed during the wait reach no draft, no later screen and are not replayed', async () => {
        const { driver, held } = await opened(transition);
        go(driver, transition);
        await driver.burst([[PROBE, 0], ['1', 10], [KEYS.enter, 10]]);
        await driver.pause(50);
        held.release();
        await driver.untilShown(transition.next);
        await driver.pause(300);
        expect(shows(transition.next)(driver.frameNow())).toBe(true);
        expect(driver.frameNow()).not.toContain(PROBE);
        await leave(driver);
        expect(driver.frameNow()).not.toContain(PROBE);
        expect(driver.backend.started).toEqual([]);
        driver.app.unmount();
      });

      if (transition.read === true || transition.waitScreen !== undefined)
        it('3: esc during the wait shows the previous screen again with its highlight where it was, and the read has no effect', async () => {
          const { driver, held } = await opened(transition);
          go(driver, transition);
          await driver.pause(20);
          driver.app.stdin.write(KEYS.escape);
          await driver.pause(100);
          expect(shows(transition.previous)(driver.frameNow())).toBe(true);
          expect(highlighted(transition.row)(driver.frameNow())).toBe(true);
          held.release();
          await driver.pause(500);
          if (transition.read === true) expect(shows(transition.next)(driver.frameNow())).toBe(false);
          expect(shows(transition.previous)(driver.frameNow())).toBe(true);
          expect(highlighted(transition.row)(driver.frameNow())).toBe(true);
          driver.app.unmount();
        });

      const second = SECOND_ENTER[`${transition.flow}: ${transition.step}`];
      if (transition.holdOn === undefined && !OWN_PINS.includes(transition.step) && second !== undefined) {
        it(`4: a second enter pressed once the opened screen is drawn acts on it at once: "${second.acted}"`, async () => {
          const { driver } = await opened(transition);
          go(driver, transition);
          await driver.untilShown(transition.next);
          driver.app.stdin.write(KEYS.enter);
          await driver.until((frame) => screenHead(frame) === second.acted, second.acted);
          expect(screenHead(driver.frameNow())).toBe(second.acted);
          driver.app.unmount();
        });
        it(`4: a second enter in the same write as the first, before the opened screen is drawn, does not act on it: "${second.opened}"`, async () => {
          const { driver } = await opened(transition);
          driver.oneWrite(`${transition.go ?? KEYS.enter}${KEYS.enter}`);
          await driver.until((frame) => screenHead(frame) === second.opened, second.opened);
          await driver.pause(500);
          expect(screenHead(driver.frameNow())).toBe(second.opened);
          driver.app.unmount();
        });
      }
      if (transition.holdOn !== undefined) for (const gap of [0, 20, 60, 150]) {
        it(`4: a second enter ${gap} ms after the first does nothing: the next screen shows and is unanswered`, async () => {
          const { driver, held } = await opened(transition);
          go(driver, transition);
          await driver.burst([[KEYS.enter, gap]]);
          await driver.pause(50);
          held.release();
          await driver.untilShown(transition.next);
          await driver.pause(500);
          expect(shows(transition.next)(driver.frameNow())).toBe(true);
          driver.app.unmount();
        });
      }
    });
  }
});

describe('esc on a text field goes back to the list it was opened from, that row highlighted, and the half-typed text is neither kept nor put in the prompt', () => {
  for (const transition of transitions.filter((candidate) => candidate.field === true)) {
    it(`${transition.flow}: ${transition.step}`, async () => {
      const { driver, held } = await opened(transition);
      held.release();
      go(driver, transition);
      await driver.untilShown(transition.next);
      await driver.settled();
      await driver.step('half', 'half');
      driver.app.stdin.write(KEYS.escape);
      await driver.pause(300);
      expect(shows(transition.previous)(driver.frameNow())).toBe(true);
      expect(highlighted(transition.row)(driver.frameNow())).toBe(true);
      expect(driver.frameNow()).not.toContain('half');
      await driver.settled();
      go(driver, transition);
      await driver.untilShown(transition.next);
      expect(driver.frameNow()).not.toContain('half');
      await leave(driver);
      expect(driver.frameNow()).not.toContain('half');
      driver.app.unmount();
    });
  }
});

describe('a second enter after a screen opened with no wait, where the rule decides more than the screen shown', () => {
  const rowOf = (step: string): Transition => {
    const found = transitions.find((candidate) => candidate.step === step);
    if (found === undefined) throw new Error(`no transition ${step}`);
    return found;
  };

  for (const [gap, started] of [[0, []], [20, ['an earlier prompt']], [60, ['an earlier prompt']], [150, ['an earlier prompt']]] as const) {
    it(`history search: a second enter ${gap} ms after the first ${gap === 0 ? 'is pressed while the list is the screen and is dropped: the prompt holds the text, nothing is sent' : 'reaches the prompt holding the text and sends it, as the prompt does'}`, async () => {
      const transition = rowOf(HISTORY_ROW);
      const { driver } = await opened(transition);
      go(driver, transition);
      await driver.burst([[KEYS.enter, gap]]);
      await driver.pause(500);
      expect(driver.backend.started.map((run) => run.text)).toEqual([...started]);
      expect(inputLineOf(driver.frameNow()).trimEnd()).toBe(gap === 0 ? '> an earlier prompt' : '>');
      driver.app.unmount();
    });
  }

  it('Forget after (days): a second enter at once is dropped and the field stays with its value', async () => {
    const transition = rowOf(FORGET_ROW);
    const { driver } = await opened(transition);
    const saving = hold(driver.backend, 'editSettings');
    go(driver, transition);
    await driver.burst([[KEYS.enter, 0]]);
    await driver.pause(500);
    expect(screenHead(driver.frameNow())).toBe('Forget after (days) / a whole number from 1');
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> 90');
    expect(saving.calls()).toBe(0);
    saving.release();
    driver.app.unmount();
  });

  for (const gap of [20, 60, 150]) {
    it(`Forget after (days): a second enter ${gap} ms after the first saves the value shown; the save is drawn as the waiting screen of the field, then the Settings list`, async () => {
      const transition = rowOf(FORGET_ROW);
      const { driver } = await opened(transition);
      const saving = hold(driver.backend, 'editSettings');
      go(driver, transition);
      await driver.burst([[KEYS.enter, gap]]);
      await driver.pause(100);
      expect(shownLines(driver.frameNow())).toEqual(['Forget after (days)', 'saving the setting']);
      expect(saving.calls()).toBe(1);
      saving.release();
      await driver.untilShown((frame) => frame.includes('filter:'));
      expect(screenHead(driver.frameNow())).toBe('Settings / filter:');
      driver.app.unmount();
    });
  }
});
