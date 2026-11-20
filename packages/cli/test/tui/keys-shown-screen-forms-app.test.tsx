import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HOOKS_TITLE, HOOK_COMMAND_TITLE, HOOK_EVENT_TITLE, HOOK_MATCHER_TITLE, HOOK_TIMEOUT_TITLE } from '../../src/tui/commands/hooks.ts';
import { ADD_HTTP_ROW, ADD_STDIO_ROW, MCP_ARGUMENTS_TITLE, MCP_COMMAND_TITLE, MCP_ENVIRONMENT_TITLE, MCP_NAME_TITLE, MCP_SECRETS_TITLE } from '../../src/tui/commands/mcp.ts';
import { SETTINGS_TITLE } from '../../src/tui/settings-screen.tsx';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { highlighted, inputLineOf, shows, startAtRealTiming } from './keys-shown-screen.tsx';
import type { AtRealTiming, Shown, StartGiven } from './keys-shown-screen.tsx';
import type { FakePlanOptions } from '../fake-plan-gateway.tsx';
import { API_LIST, CONNECT, NO_ACCOUNT, SIGNED_IN, toRow } from './keys-shown-screen-cases.tsx';
import { freshPlace } from './settings-harness.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

type Field = { readonly answer: string; readonly shown: Shown };

type Form = {
  readonly name: string;
  readonly given: () => { readonly start: StartGiven; readonly untouched: (driver: AtRealTiming) => boolean };
  readonly reach: (driver: AtRealTiming) => Promise<void>;
  readonly list: Shown;
  readonly row: string;
  readonly fields: readonly Field[];
  readonly tested: readonly number[];
  readonly lastReached?: boolean;
};

const placed = (): { start: StartGiven; untouched: (driver: AtRealTiming) => boolean } => {
  const place = freshPlace();
  return { start: { options: { ...SIGNED_IN, settingsPlace: { home: place.home, projectDir: place.project } } }, untouched: () => !fs.existsSync(place.userFile) };
};

const noSecret = (options: FakePlanOptions) => (): { start: StartGiven; untouched: (driver: AtRealTiming) => boolean } => ({ start: { options }, untouched: (driver: AtRealTiming) => !driver.backend.calls.some((call) => call.startsWith('secret:')) });

const SETTINGS = (frame: string): boolean => frame.includes(SETTINGS_TITLE) && frame.includes('filter:');
const ADD_WAYS = (frame: string): boolean => frame.includes('Search this computer for model servers') && !frame.includes('Servers');

const openAdd = async (driver: AtRealTiming): Promise<void> => {
  await driver.submit('/model');
  await driver.untilShown('Model settings…');
  await driver.settled();
  await toRow(driver, 'Model settings…');
  await driver.step(KEYS.enter, 'Add a model');
  await toRow(driver, 'Add a model');
  await driver.step(KEYS.enter, ADD_WAYS);
};

const KEY_FIELDS: readonly Field[] = [
  { answer: KEYS.enter, shown: 'Address' },
  { answer: `http://127.0.0.1:9/v1${KEYS.enter}`, shown: 'Read the key from an environment variable' },
  { answer: KEYS.enter, shown: 'Name of the environment variable' },
];

const forms: readonly Form[] = [
  {
    name: 'Prices of /config (Provider → … → Cache write)',
    given: placed,
    reach: async (driver) => {
      await driver.submit('/config');
      await driver.untilShown(SETTINGS);
      await driver.settled();
      await driver.step('Prices', 'filter: Prices');
      await driver.step(KEYS.enter, 'Prices (user)');
      await toRow(driver, 'Add');
    },
    list: 'Prices (user)',
    row: 'Add',
    fields: [
      { answer: KEYS.enter, shown: 'Prices: Provider' },
      { answer: `acme${KEYS.enter}`, shown: 'Prices: Model' },
      { answer: `big-1${KEYS.enter}`, shown: 'Prices: In force from (YYYY-MM-DD)' },
      { answer: `2026-11-01${KEYS.enter}`, shown: 'Prices: Input, USD per million tokens' },
      { answer: `1.5${KEYS.enter}`, shown: 'Prices: Output, USD per million tokens' },
      { answer: `6${KEYS.enter}`, shown: 'Prices: Cached input, USD per million tokens (empty: none)' },
      { answer: KEYS.enter, shown: 'Prices: Cache write, USD per million tokens (empty: none)' },
    ],
    tested: [1, 6],
  },
  {
    name: '/mcp add stdio (name → command → arguments → environment → secrets)',
    given: placed,
    reach: async (driver) => {
      await driver.submit('/mcp');
      await driver.untilShown(ADD_HTTP_ROW);
      await driver.settled();
      await toRow(driver, ADD_STDIO_ROW);
    },
    list: ADD_HTTP_ROW,
    row: ADD_STDIO_ROW,
    fields: [
      { answer: KEYS.enter, shown: MCP_NAME_TITLE },
      { answer: `files${KEYS.enter}`, shown: MCP_COMMAND_TITLE },
      { answer: `npx${KEYS.enter}`, shown: MCP_ARGUMENTS_TITLE },
      { answer: `-y files-server${KEYS.enter}`, shown: MCP_ENVIRONMENT_TITLE },
      { answer: `FILES_ROOT${KEYS.enter}`, shown: MCP_SECRETS_TITLE },
    ],
    tested: [1, 4],
  },
  {
    name: '/hooks add (event → matcher → command → timeout)',
    given: placed,
    reach: async (driver) => {
      await driver.submit('/hooks');
      await driver.untilShown(HOOKS_TITLE);
      await driver.settled();
      await toRow(driver, 'Add');
      await driver.step(KEYS.enter, HOOK_EVENT_TITLE);
      await toRow(driver, 'PreToolUse');
    },
    list: (frame) => frame.includes(HOOK_EVENT_TITLE) && !frame.includes(HOOK_MATCHER_TITLE),
    row: 'PreToolUse',
    fields: [
      { answer: KEYS.enter, shown: HOOK_MATCHER_TITLE },
      { answer: `Bash${KEYS.enter}`, shown: HOOK_COMMAND_TITLE },
      { answer: `echo checked${KEYS.enter}`, shown: HOOK_TIMEOUT_TITLE },
    ],
    tested: [1, 2],
  },
  {
    name: 'models add, a service with an API key (Address → key → variable name)',
    given: noSecret(SIGNED_IN),
    reach: async (driver) => {
      await openAdd(driver);
      await toRow(driver, 'Use a service with an API key');
      await driver.step(KEYS.enter, API_LIST);
      await toRow(driver, 'OpenAI-compatible API');
    },
    list: API_LIST,
    row: 'OpenAI-compatible API',
    fields: KEY_FIELDS,
    tested: [2],
  },
  {
    name: '/login, a service with an API key (Address → key → variable name)',
    given: noSecret(NO_ACCOUNT),
    reach: async (driver) => {
      await driver.submit('/login');
      await driver.untilShown(CONNECT);
      await driver.settled();
      await toRow(driver, 'Add an API key');
      await driver.step(KEYS.enter, API_LIST);
      await toRow(driver, 'OpenAI-compatible API');
    },
    list: API_LIST,
    row: 'OpenAI-compatible API',
    fields: KEY_FIELDS,
    tested: [2],
  },
  {
    name: 'models add, a program (path → arguments → ready path)',
    given: noSecret(SIGNED_IN),
    reach: async (driver) => {
      await openAdd(driver);
      await toRow(driver, 'Run a program as a model server');
    },
    list: ADD_WAYS,
    row: 'Run a program as a model server',
    fields: [
      { answer: KEYS.enter, shown: 'Write the full path of the program.' },
      { answer: `/usr/bin/true${KEYS.enter}`, shown: 'Arguments' },
      { answer: `--x{socket}${KEYS.enter}`, shown: 'Path that answers when it is ready' },
    ],
    tested: [1, 2],
    lastReached: true,
  },
];

const ordinal = (form: Form, index: number): string => (index === form.fields.length - 1 ? (form.lastReached === true ? `field ${index + 1}, the last one this test reaches` : 'the last field') : `field ${index + 1}`);

describe('esc on a later field of a multi-field form cancels the whole entry: back to the list it was started from, its row highlighted, nothing saved, nothing kept', () => {
  for (const form of forms) {
    for (const at of form.tested) {
      it(`${form.name}: esc on ${ordinal(form, at)}`, async () => {
        const { start, untouched } = form.given();
        const driver = await startAtRealTiming(start);
        await form.reach(driver);
        for (const field of form.fields.slice(0, at + 1)) await driver.step(field.answer, field.shown);
        await driver.step('half', 'half');
        driver.app.stdin.write(KEYS.escape);
        await driver.pause(300);
        expect(shows(form.list)(driver.frameNow())).toBe(true);
        expect(highlighted(form.row)(driver.frameNow())).toBe(true);
        expect(driver.frameNow()).not.toContain('half');
        expect(untouched(driver)).toBe(true);
        const first = form.fields[0];
        if (first !== undefined) await driver.step(first.answer, first.shown);
        expect(driver.frameNow()).not.toContain('half');
        expect(driver.frameNow()).not.toContain('acme');
        expect(driver.frameNow()).not.toContain('files-server');
        for (let leave = 0; leave < 6 && !driver.frameNow().includes('mode: manual'); leave += 1) await driver.step(KEYS.escape, () => true);
        await driver.pause(300);
        expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('>');
        expect(untouched(driver)).toBe(true);
        driver.app.unmount();
      });
    }
  }
});
