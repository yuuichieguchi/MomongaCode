import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CREATE_FROM_TEMPLATE_ROW, SKILLS_TITLE, TEMPLATE_NAME_TITLE } from '../../src/tui/commands/skills.ts';
import { SAVING_SETTING, SETTINGS_TITLE } from '../../src/tui/settings-screen.tsx';
import { createKeyBindings } from '../../src/tui/keys/store.ts';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { PROBE, highlighted, inputLineOf, shows, startAtRealTiming } from './keys-shown-screen.tsx';
import type { AtRealTiming, Shown, StartGiven } from './keys-shown-screen.tsx';
import type { FakePlanOptions } from '../fake-plan-gateway.tsx';
import { ADDRESS, API_LIST, CONNECT, NO_ACCOUNT, SIGNED_IN, endings, keyFilesHeld, toRow, transitions } from './keys-shown-screen-cases.tsx';
import { freshPlace } from './settings-harness.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

type EnterAndEsc = readonly [string, (driver: AtRealTiming, keys: string) => void];
const ENTER_AND_ESC_FORMS: readonly EnterAndEsc[] = [
  ['one write, the lone esc ended by the parser hold', (driver, keys) => driver.oneWrite(`${keys}${KEYS.escape}`)],
  ['one batch with esc as CSI 27u', (driver, keys) => driver.oneBatch(keys)],
];

const cancels = (driver: AtRealTiming): string[] => driver.backend.calls.filter((call) => call.startsWith('cancel:'));
const everShown = (driver: AtRealTiming, shown: Shown): boolean => driver.app.frames.some(shows(shown));

describe('(a) the last step of a flow is a save: the list closes at the choice, the save goes on, and keys go to the prompt at once', () => {
  for (const ending of endings()) {
    const opened = async () => {
      const driver = await startAtRealTiming(ending.given());
      await ending.reach(driver);
      const held = ending.holdOn(driver);
      return { driver, held };
    };

    describe(ending.flow, () => {
      it('the list is gone in the next frame while the save is still held, and the result line follows when it ends', async () => {
        const { driver, held } = await opened();
        driver.app.stdin.write(ending.choose ?? KEYS.enter);
        await driver.pause(20);
        expect(ending.saved(driver) || held.calls() > 0).toBe(true);
        expect(shows(ending.list)(driver.frameNow())).toBe(false);
        held.release();
        await driver.pause(500);
        expect(everShown(driver, ending.result)).toBe(true);
        driver.app.unmount();
      });

      it('text typed while the save is held shows in the prompt at once, once, and nothing is replayed when it ends', async () => {
        const { driver, held } = await opened();
        driver.app.stdin.write(ending.choose ?? KEYS.enter);
        await driver.pause(20);
        driver.app.stdin.write(PROBE);
        await driver.pause(20);
        expect(inputLineOf(driver.frameNow()).trimEnd()).toBe(`> ${PROBE}`);
        held.release();
        await driver.pause(500);
        expect(inputLineOf(driver.frameNow()).trimEnd()).toBe(`> ${PROBE}`);
        expect(driver.backend.started).toEqual([]);
        driver.app.unmount();
      });

      it('enter on the empty prompt while the save is held does what it does on the empty prompt with no flow: nothing is sent', async () => {
        const { driver, held } = await opened();
        driver.app.stdin.write(ending.choose ?? KEYS.enter);
        await driver.pause(20);
        driver.app.stdin.write(KEYS.enter);
        await driver.pause(50);
        expect(driver.backend.started).toEqual([]);
        held.release();
        await driver.pause(500);
        expect(driver.backend.started).toEqual([]);
        expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('>');
        expect(shows(ending.list)(driver.frameNow())).toBe(false);
        driver.app.unmount();
      });

      it('esc while the save is held with no run cancels no run and brings no list back', async () => {
        const { driver, held } = await opened();
        driver.app.stdin.write(ending.choose ?? KEYS.enter);
        await driver.pause(20);
        driver.app.stdin.write(KEYS.escape);
        await driver.pause(50);
        expect(shows(ending.list)(driver.frameNow())).toBe(false);
        held.release();
        await driver.pause(500);
        expect(cancels(driver)).toEqual([]);
        expect(shows(ending.list)(driver.frameNow())).toBe(false);
        expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('>');
        driver.app.unmount();
      });
    });
  }
});

type OneWrite = {
  readonly next: string;
  readonly given: () => FakePlanOptions | StartGiven | Promise<StartGiven>;
  readonly reach: (driver: AtRealTiming) => Promise<void>;
  readonly previous: Shown;
  readonly opened: Shown;
  readonly row: string;
  readonly untouched: (driver: AtRealTiming) => boolean;
};

const settingsPlace = () => {
  let userFile = '';
  return {
    get given(): StartGiven {
      const place = freshPlace();
      userFile = place.userFile;
      return { options: { ...SIGNED_IN, settingsPlace: { home: place.home, projectDir: place.project } } };
    },
    get userFile(): string {
      return userFile;
    },
  };
};

const filterTo = async (driver: AtRealTiming, label: string): Promise<void> => {
  await driver.step(label, `filter: ${label}`);
  await driver.untilShown(highlighted(label));
  await driver.settled();
};

const SETTINGS = (frame: string): boolean => frame.includes(SETTINGS_TITLE) && frame.includes('filter:');

const oneWrites = (): readonly OneWrite[] => {
  const forget = settingsPlace();
  const sandbox = settingsPlace();
  const keys = keyFilesHeld();
  return [
    {
      next: 'a text field (OpenAI-compatible API → Address)',
      given: () => NO_ACCOUNT,
      reach: async (driver) => {
        await driver.submit('/login');
        await driver.untilShown(CONNECT);
        await driver.settled();
        await toRow(driver, 'Add an API key');
        await driver.step(KEYS.enter, API_LIST);
        await toRow(driver, 'OpenAI-compatible API');
      },
      previous: API_LIST,
      opened: ADDRESS,
      row: 'OpenAI-compatible API',
      untouched: (driver) => !driver.backend.calls.some((call) => call.startsWith('secret:')),
    },
    {
      next: 'a text field (Forget after (days) of /config)',
      given: () => forget.given,
      reach: async (driver) => {
        await driver.submit('/config');
        await driver.untilShown(SETTINGS);
        await driver.settled();
        await filterTo(driver, 'Forget after (days)');
      },
      previous: SETTINGS,
      opened: 'a whole number from 1',
      row: 'Forget after (days)',
      untouched: () => !fs.existsSync(forget.userFile),
    },
    {
      next: 'a text field (Create from a template of /skills)',
      given: () => SIGNED_IN,
      reach: async (driver) => {
        await driver.submit('/skills');
        await driver.untilShown(SKILLS_TITLE);
        await driver.settled();
        await toRow(driver, CREATE_FROM_TEMPLATE_ROW);
      },
      previous: CREATE_FROM_TEMPLATE_ROW,
      opened: TEMPLATE_NAME_TITLE,
      row: CREATE_FROM_TEMPLATE_ROW,
      untouched: (driver) => !driver.backend.calls.some((call) => call.includes('template')),
    },
    {
      next: 'a key capture (an action of /keybindings)',
      given: async () => {
        const keyBindings = createKeyBindings({ file: '/home/u/.momonga/keybindings.json', shownFile: '~/.momonga/keybindings.json', files: keys.files });
        await keyBindings.load();
        return { options: SIGNED_IN, extra: { keyBindings } };
      },
      reach: async (driver) => {
        await driver.submit('/keybindings');
        await driver.untilShown('Key bindings');
        await driver.settled();
        await driver.step('history.search', 'filter: history.search');
        await driver.untilShown(highlighted('history.search'));
      },
      previous: 'Key bindings',
      opened: 'Press the new key for history.search',
      row: 'history.search',
      untouched: () => keys.written.length === 0,
    },
    {
      next: 'a list whose esc goes back (the choices of Sandbox in /config)',
      given: () => sandbox.given,
      reach: async (driver) => {
        await driver.submit('/config');
        await driver.untilShown(SETTINGS);
        await driver.settled();
        await filterTo(driver, 'Sandbox');
      },
      previous: SETTINGS,
      opened: (frame: string) => frame.includes('1. seatbelt') && frame.includes('3. none'),
      row: 'Sandbox',
      untouched: () => !fs.existsSync(sandbox.userFile),
    },
  ];
};

describe('(b) enter and esc in one write on a list row whose next screen opens with no wait', () => {
  for (const [form, press] of ENTER_AND_ESC_FORMS) for (const write of oneWrites()) {
    it(`${form}: the esc closes ${write.next} that has just opened: the list is shown again with its row highlighted and nothing of the next screen took effect`, async () => {
      const driver = await startAtRealTiming(await write.given());
      await write.reach(driver);
      press(driver, KEYS.enter);
      await driver.pause(500);
      expect(shows(write.opened)(driver.frameNow())).toBe(false);
      expect(shows(write.previous)(driver.frameNow())).toBe(true);
      expect(highlighted(write.row)(driver.frameNow())).toBe(true);
      expect(write.untouched(driver)).toBe(true);
      driver.app.unmount();
    });
  }
});

describe('(c) a text field left with esc and opened again starts empty or with its initial value', () => {
  it('the Address field of /login: the half-typed address is gone when it opens again, and is not put in the prompt', async () => {
    const driver = await startAtRealTiming(NO_ACCOUNT);
    const toAddress = async (): Promise<void> => {
      await driver.submit('/login');
      await driver.untilShown(CONNECT);
      await driver.settled();
      await toRow(driver, 'Add an API key');
      await driver.step(KEYS.enter, API_LIST);
      await toRow(driver, 'OpenAI-compatible API');
      await driver.step(KEYS.enter, ADDRESS);
    };
    await toAddress();
    await driver.step('http://half', 'http://half');
    await driver.step(KEYS.escape, (frame) => !frame.includes('Address:'));
    for (let leave = 0; leave < 4 && !driver.frameNow().includes('mode: manual'); leave += 1) await driver.step(KEYS.escape, () => true);
    await driver.pause(300);
    expect(driver.frameNow()).not.toContain('http://half');
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('>');
    await toAddress();
    expect(driver.frameNow()).not.toContain('http://half');
    driver.app.unmount();
  });

  it('a number setting of /config: the half-typed digits are gone when it opens again, and are not put in the prompt', async () => {
    const { given } = settingsPlace();
    const driver = await startAtRealTiming(given);
    await driver.submit('/config');
    await driver.untilShown(SETTINGS);
    await driver.settled();
    await filterTo(driver, 'Forget after (days)');
    await driver.step(KEYS.enter, 'a whole number from 1');
    await driver.step('987', '987');
    await driver.step(KEYS.escape, SETTINGS);
    await driver.step(KEYS.enter, 'a whole number from 1');
    expect(driver.frameNow()).not.toContain('987');
    for (let leave = 0; leave < 4 && !driver.frameNow().includes('mode: manual'); leave += 1) await driver.step(KEYS.escape, () => true);
    await driver.pause(300);
    expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('>');
    driver.app.unmount();
  });
});

const ROW_CHOICE_QUESTIONS = [
  'ChatGPT → The sandbox is off, the sandbox read later',
  'the none choice → the question before the sandbox is turned off',
  'delete on an entry → the remove question',
  'delete on a rule → the remove question',
  'delete on a hook → the remove question',
  'a server of the user file → the remove question',
  'Reset all to the defaults → its question',
  'a key another action uses, captured → the Replace question',
];

const LIST_BEFORE: Readonly<Record<string, Shown>> = {
  'a key another action uses, captured → the Replace question': (frame) => frame.includes('Key bindings') && frame.includes('filter:') && !frame.includes('Press the new key'),
};

describe('enter and esc in one write on a row that opens a confirmation: the esc closes it as No at once and the previous list shows', () => {
  for (const [form, press] of ENTER_AND_ESC_FORMS) for (const transition of transitions.filter((candidate) => ROW_CHOICE_QUESTIONS.includes(candidate.step))) {
    it(`${form}: ${transition.flow}: ${transition.step}`, async () => {
      const driver = await startAtRealTiming(await transition.given());
      await transition.reach(driver);
      press(driver, transition.go ?? KEYS.enter);
      await driver.pause(500);
      expect(shows(transition.next)(driver.frameNow())).toBe(false);
      expect(shows(LIST_BEFORE[transition.step] ?? transition.previous)(driver.frameNow())).toBe(true);
      expect(driver.backend.planCalls.filter((call) => call.route === 'sign-in/begin')).toEqual([]);
      driver.app.unmount();
    });
  }
});

describe('esc during a save with its own wait row and no run: the save is cancelled and no list comes back', () => {
  it('/theme: esc aborts the save, the row "saving the theme" clears, no list comes back, and the saved line is not printed', async () => {
    const gate = Promise.withResolvers<void>();
    const events: string[] = [];
    const port = {
      initial: { theme: 'auto', notify: 'off', screenReader: false, reducedMotion: false, screen: 'fullscreen', mouse: true, copyOnSelect: true, attachFileMentions: true },
      save: async (name: string, value: unknown, signal: AbortSignal) => {
        events.push(`save ${name}:${String(value)}`);
        signal.addEventListener('abort', () => events.push('aborted'));
        await gate.promise;
      },
    };
    const driver = await startAtRealTiming({ options: SIGNED_IN, extra: { tuiSettings: port as never } });
    await driver.submit('/theme');
    await driver.untilShown('Theme');
    await driver.settled();
    await toRow(driver, 'dark');
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(30);
    driver.app.stdin.write(KEYS.escape);
    await driver.pause(100);
    expect(events).toEqual(['save theme:dark', 'aborted']);
    expect(driver.frameNow()).not.toContain('saving the theme');
    expect(driver.frameNow()).not.toContain('esc: go back');
    gate.resolve();
    await driver.pause(500);
    expect(driver.frameNow()).not.toContain('saving the theme');
    expect(driver.frameNow()).not.toContain('theme: dark');
    expect(cancels(driver)).toEqual([]);
    driver.app.unmount();
  });
});

const transitionOf = (step: string) => {
  const found = transitions.find((candidate) => candidate.step === step);
  if (found === undefined) throw new Error(`no transition ${step}`);
  return found;
};

describe('an enter right after a list is drawn again takes the highlighted row', () => {
  it('a text field, esc back to its list, enter at once: the highlighted row opens the field again', async () => {
    const transition = transitionOf('Type the address of a model server → the address field');
    const driver = await startAtRealTiming(await transition.given());
    await transition.reach(driver);
    driver.app.stdin.write(KEYS.enter);
    await driver.untilShown(transition.next);
    driver.app.stdin.write(KEYS.escape);
    await driver.untilShown((frame) => shows(transition.previous)(frame) && !shows(transition.next)(frame) && highlighted(transition.row)(frame));
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(500);
    expect(shows(transition.next)(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });

  it('/model: esc on the effort screen back to the model list, enter at once: the highlighted model opens its effort screen again', async () => {
    const transition = transitionOf('a configured model row → Reasoning effort, the listing read later');
    const driver = await startAtRealTiming(await transition.given());
    await transition.reach(driver);
    driver.app.stdin.write(KEYS.enter);
    await driver.untilShown(transition.next);
    driver.app.stdin.write(KEYS.escape);
    await driver.untilShown((frame) => shows(transition.previous)(frame) && !shows(transition.next)(frame) && highlighted(transition.row)(frame));
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(500);
    expect(shows(transition.next)(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });

  it('settings: the save ends and the list is drawn again, enter at once starts the save of the highlighted row again', async () => {
    const transition = transitionOf('a toggle (Automatic compaction) written → the settings list read again later');
    const driver = await startAtRealTiming(await transition.given());
    await transition.reach(driver);
    driver.app.stdin.write(KEYS.enter);
    await driver.untilShown(transition.next);
    const since = driver.mark();
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(500);
    expect(since().some((frame) => frame.includes(SAVING_SETTING))).toBe(true);
    driver.app.unmount();
  });

  it('settings: an enter pressed before the list is drawn again is dropped', async () => {
    const transition = transitionOf('a toggle (Automatic compaction) written → the settings list read again later');
    const driver = await startAtRealTiming(await transition.given());
    await transition.reach(driver);
    const held = transition.holdOn?.(driver);
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(20);
    driver.app.stdin.write(KEYS.enter);
    await driver.pause(20);
    held?.release();
    await driver.untilShown(transition.next);
    await driver.pause(500);
    expect(shows(transition.next)(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });
});

describe('enter and esc in one write on a row that saves and ends', () => {
  const ending = (flow: string) => {
    const found = endings().find((candidate) => candidate.flow === flow);
    if (found === undefined) throw new Error(`no ending ${flow}`);
    return found;
  };

  for (const [form, press] of ENTER_AND_ESC_FORMS) {
  it(`${form}: /mode with no run working: the list closes, the setting is saved, the esc does nothing`, async () => {
    const mode = ending('/mode');
    const driver = await startAtRealTiming(mode.given());
    await mode.reach(driver);
    press(driver, KEYS.enter);
    await driver.pause(500);
    expect(shows(mode.list)(driver.frameNow())).toBe(false);
    expect(driver.backend.calls.filter((call) => call.startsWith('mode:'))).toEqual(['mode:acceptEdits']);
    expect(everShown(driver, mode.result)).toBe(true);
    expect(cancels(driver)).toEqual([]);
    driver.app.unmount();
  });

  it(`${form}: /mode while another run is working: the list closes, the setting is saved, the working run stops`, async () => {
    const mode = ending('/mode');
    const driver = await startAtRealTiming(mode.given());
    await driver.submit('long task');
    await driver.until(() => driver.backend.started.length === 1, 'the run started');
    await driver.settled();
    await mode.reach(driver);
    press(driver, KEYS.enter);
    await driver.pause(500);
    expect(shows(mode.list)(driver.frameNow())).toBe(false);
    expect(driver.backend.calls.filter((call) => call.startsWith('mode:'))).toEqual(['mode:acceptEdits']);
    expect(cancels(driver)).toHaveLength(1);
    driver.app.unmount();
  });
  }
});
