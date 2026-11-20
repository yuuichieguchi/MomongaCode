import { describe, expect, it, vi } from 'vitest';
import type { PlanModelsResponse, ReasoningCapability } from '@momonga/protocol';
import { account } from '../fake-plan-gateway.tsx';
import type { FakePlanBackend, FakePlanOptions } from '../fake-plan-gateway.tsx';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { PROBE, hold, inputLineOf, startAtRealTiming } from './keys-shown-screen.tsx';
import type { AtRealTiming, Held } from './keys-shown-screen.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const QWEN = 'ollama/qwen3.8:27b';
const LUNA = 'chatgpt/gpt-6-luna';
const REASONING: ReasoningCapability = { control: 'reasoning_effort', lowest: 'low' };
const usable = (slug: string): PlanModelsResponse['models'][number] => ({ slug, displayName: slug.toUpperCase(), usable: true, contextWindow: 272000, maxOutputTokens: 128000 });

const SIGNED_IN: FakePlanOptions = {
  session: { model: QWEN },
  models: [QWEN, LUNA],
  billing: { [QWEN]: 'local', [LUNA]: 'plan' },
  reasoning: { [QWEN]: REASONING, [LUNA]: REASONING },
  accounts: [account()],
  catalogs: { chatgpt: { readAt: '2026-11-10T00:00:00.000Z', models: [usable('gpt-6.2-sol')] } },
  dismissed: { 'invite:chatgpt': 'x' },
};

const NO_ACCOUNT: FakePlanOptions = { ...SIGNED_IN, accounts: [], catalogs: {} };

const MODEL_LIST = (frame: string): boolean => frame.includes('Model settings…');
const EFFORT_PICKER = (frame: string): boolean => frame.includes('Reasoning effort') && frame.includes('1. low');
const LOADING = (frame: string): boolean => frame.includes('Loading models…');
const CONNECT = (frame: string): boolean => frame.includes('Add an API key');
const SANDBOX_OFF = (frame: string): boolean => frame.includes('The sandbox is off');
const API_LIST = (frame: string): boolean => frame.includes('OpenAI-compatible API') && !frame.includes('Address:');
const ADDRESS = (frame: string): boolean => frame.includes('Address:');

const rowOf = (frame: string, label: string): number => {
  const line = frame.split('\n').find((row) => /\d+\. /.test(row) && row.includes(label));
  if (line === undefined) throw new Error(`no row ${label} in:\n${frame}`);
  return Number(/(\d+)\. /.exec(line)?.[1]);
};

const highlighted = (label: string) => (frame: string): boolean => frame.split('\n').some((row) => row.includes('›') && row.includes(label));

const moveTo = (frame: string, label: string): string => KEYS.down.repeat(rowOf(frame, label) - 1);

type Transition = {
  readonly flow: string;
  readonly step: string;
  readonly options: FakePlanOptions;
  readonly open: (driver: AtRealTiming) => Promise<void>;
  readonly previous: (frame: string) => boolean;
  readonly between: readonly ((frame: string) => boolean)[];
  readonly next: (frame: string) => boolean;
  readonly row: string;
  readonly holdOn: (backend: FakePlanBackend) => Held;
};

const openModelList = async (driver: AtRealTiming): Promise<void> => {
  await driver.submit('/model');
  await driver.untilShown(MODEL_LIST);
  await driver.settled();
};

const openConnect = async (driver: AtRealTiming): Promise<void> => {
  await driver.submit('/login');
  await driver.untilShown(CONNECT);
  await driver.settled();
};

const transitions: readonly Transition[] = [
  {
    flow: '/model',
    step: 'a configured model row to its effort list, the listing read later',
    options: SIGNED_IN,
    open: openModelList,
    previous: MODEL_LIST,
    between: [LOADING],
    next: EFFORT_PICKER,
    row: 'gpt-6-luna',
    holdOn: (backend) => hold(backend, 'models'),
  },
  {
    flow: '/login',
    step: 'the ChatGPT row to the sandbox question, the sandbox read later',
    options: NO_ACCOUNT,
    open: openConnect,
    previous: CONNECT,
    between: [],
    next: SANDBOX_OFF,
    row: 'ChatGPT',
    holdOn: (backend) => {
      Object.assign(backend, { sandbox: async () => 'none' as const });
      return hold(backend, 'sandbox');
    },
  },
];

const enterOn = async (driver: AtRealTiming, row: string): Promise<void> => {
  driver.app.stdin.write(`${moveTo(driver.frameNow(), row)}`);
  await driver.untilShown(highlighted(row));
  driver.app.stdin.write(KEYS.enter);
};

const opened = async (transition: Transition) => {
  const driver = await startAtRealTiming(transition.options);
  await transition.open(driver);
  const held = transition.holdOn(driver.backend);
  return { driver, held };
};

describe('between two screens of a flow, the screen showing stays until the next one replaces it, and a key acts only on the screen showing', () => {
  for (const transition of transitions) {
    describe(`${transition.flow}: ${transition.step}`, () => {
      it('no frame between the two screens shows the bare prompt', async () => {
        const { driver, held } = await opened(transition);
        const since = driver.mark();
        await enterOn(driver, transition.row);
        await driver.pause(100);
        held.release();
        await driver.untilShown(transition.next);
        const shown = (frame: string): boolean => [transition.previous, ...transition.between, transition.next].some((screen) => screen(frame));
        expect(since().filter((frame) => !shown(frame))).toEqual([]);
        driver.app.unmount();
      });

      it('characters, digits and enter pressed during the wait reach no draft, no later screen and are not replayed', async () => {
        const { driver, held } = await opened(transition);
        await enterOn(driver, transition.row);
        await driver.pause(20);
        await driver.burst([[PROBE, 0], ['1', 10], [KEYS.enter, 10]]);
        await driver.pause(50);
        held.release();
        await driver.untilShown(transition.next);
        await driver.pause(300);
        expect(transition.next(driver.frameNow())).toBe(true);
        expect(driver.frameNow()).not.toContain(PROBE);
        for (let leave = 0; leave < 4 && inputLineOf(driver.frameNow()) === ''; leave += 1) {
          driver.app.stdin.write(KEYS.escape);
          await driver.pause(300);
        }
        expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('>');
        expect(driver.backend.started).toEqual([]);
        driver.app.unmount();
      });

      it('esc during the wait shows the previous screen again with its highlight where it was, and the awaited step has no effect', async () => {
        const { driver, held } = await opened(transition);
        await enterOn(driver, transition.row);
        await driver.pause(20);
        driver.app.stdin.write(KEYS.escape);
        await driver.pause(100);
        expect(transition.previous(driver.frameNow())).toBe(true);
        expect(highlighted(transition.row)(driver.frameNow())).toBe(true);
        held.release();
        await driver.pause(500);
        expect(transition.next(driver.frameNow())).toBe(false);
        expect(transition.previous(driver.frameNow())).toBe(true);
        driver.app.unmount();
      });

      for (const gap of [0, 20, 60, 150]) {
        it(`a second enter ${gap} ms after the first does nothing: the next screen shows and is unanswered`, async () => {
          const { driver, held } = await opened(transition);
          await enterOn(driver, transition.row);
          await driver.burst([[KEYS.enter, gap]]);
          await driver.pause(50);
          held.release();
          await driver.untilShown(transition.next);
          await driver.pause(500);
          expect(transition.next(driver.frameNow())).toBe(true);
          driver.app.unmount();
        });
      }
    });
  }
});

describe('enter and esc in one write on a list row whose next screen is a text field', () => {
  it('the esc acts on the screen showing when it is read: the text field opened by the enter is the one it leaves, back to the list, and nothing is saved', async () => {
    const driver = await startAtRealTiming(NO_ACCOUNT);
    await openConnect(driver);
    driver.app.stdin.write(moveTo(driver.frameNow(), 'Add an API key'));
    await driver.untilShown(highlighted('Add an API key'));
    driver.app.stdin.write(KEYS.enter);
    await driver.untilShown(API_LIST);
    await driver.settled();
    driver.app.stdin.write(moveTo(driver.frameNow(), 'OpenAI-compatible API'));
    await driver.untilShown(highlighted('OpenAI-compatible API'));
    driver.app.stdin.write(`${KEYS.enter}${KEYS.escape}`);
    await driver.pause(500);
    expect(ADDRESS(driver.frameNow())).toBe(false);
    expect(API_LIST(driver.frameNow())).toBe(true);
    expect(highlighted('OpenAI-compatible API')(driver.frameNow())).toBe(true);
    driver.app.unmount();
  });
});

type Ending = {
  readonly flow: string;
  readonly open: (driver: AtRealTiming) => Promise<void>;
  readonly choose: string;
  readonly holdOn: (backend: FakePlanBackend) => Held;
  readonly written: (calls: readonly string[]) => readonly string[];
};

const endings: readonly Ending[] = [
  {
    flow: '/mode, a mode chosen and saved later',
    open: async (driver) => {
      await driver.submit('/mode');
      await driver.untilShown('Permission mode');
      await driver.settled();
      driver.app.stdin.write(KEYS.down);
      await driver.settled();
    },
    choose: KEYS.enter,
    holdOn: (backend) => hold(backend, 'setMode'),
    written: (calls) => calls.filter((call) => call.startsWith('mode:')),
  },
  {
    flow: '/effort, a level chosen and saved later',
    open: async (driver) => {
      await driver.submit('/effort');
      await driver.untilShown(EFFORT_PICKER);
      await driver.settled();
    },
    choose: KEYS.enter,
    holdOn: (backend) => hold(backend, 'setEffort'),
    written: (calls) => calls.filter((call) => call.startsWith('effort:')),
  },
  {
    flow: '/logout, the account confirmed and signed out later',
    open: async (driver) => {
      await driver.submit('/logout');
      await driver.untilShown((frame) => frame.includes('Sign out') && /\d+\. /.test(frame));
      await driver.settled();
      driver.app.stdin.write(KEYS.enter);
      await driver.untilShown('again to sign out');
      await driver.settled();
    },
    choose: KEYS.enter,
    holdOn: (backend) => hold(backend.plan, 'signOut'),
    written: () => [],
  },
  {
    flow: '/model, an effort level chosen and the switch saved later',
    open: async (driver) => {
      await openModelList(driver);
      await enterOn(driver, 'gpt-6-luna');
      await driver.untilShown(EFFORT_PICKER);
      await driver.settled();
    },
    choose: KEYS.enter,
    holdOn: (backend) => hold(backend, 'setModel'),
    written: (calls) => calls.filter((call) => call.startsWith('model:')),
  },
];

describe('keys pressed while the last step of a flow is saved are dropped, never put in the prompt and never replayed', () => {
  for (const ending of endings) {
    it(`${ending.flow}: typed text and enter during the save leave the prompt empty and start no run`, async () => {
      const driver = await startAtRealTiming(SIGNED_IN);
      await ending.open(driver);
      const held = ending.holdOn(driver.backend);
      driver.app.stdin.write(ending.choose);
      await driver.pause(20);
      await driver.burst([[PROBE, 0], [KEYS.enter, 10]]);
      await driver.pause(50);
      held.release();
      await driver.pause(500);
      expect(driver.frameNow()).not.toContain(PROBE);
      expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('>');
      expect(driver.backend.started).toEqual([]);
      expect(ending.written(driver.backend.calls).length).toBeLessThanOrEqual(1);
      driver.app.unmount();
    });
  }
});
