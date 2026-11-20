import { describe, expect, it, vi } from 'vitest';
import type { PlanModelsResponse } from '@momonga/protocol';
import { ADD_HTTP_ROW } from '../../src/tui/commands/mcp.ts';
import { APPROVE_ROW } from '../../src/tui/project-items.ts';
import { account } from '../fake-plan-gateway.tsx';
import type { FakePlanBackend } from '../fake-plan-gateway.tsx';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { PROBE, highlighted, hold, inputLineOf, shows, startAtRealTiming } from './keys-shown-screen.tsx';
import type { AtRealTiming, Held, Shown } from './keys-shown-screen.tsx';
import { SIGNED_IN, toRow } from './keys-shown-screen-cases.tsx';
import { freshPlace } from './settings-harness.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const GPT: PlanModelsResponse = { readAt: '2026-11-10T00:00:00.000Z', models: [{ slug: 'gpt-5.1', displayName: 'GPT-5.1', usable: true, contextWindow: 272000, maxOutputTokens: 128000 }] };
const CATALOG: Shown = (frame) => frame.includes('gpt-5.1') && /\d+\. /.test(frame) && !frame.includes('chatgpt · ada@example.com');
const WAITING: Shown = 'On a remote machine? Paste the redirect URL here';
const PICKER: Shown = 'Add another account or workspace';
const ADD_WAYS: Shown = (frame) => frame.includes('Search this computer for model servers') && !frame.includes('Servers');
const BUILT_IN_ROW = 'Use the Apple on-device model';

type Step = {
  readonly name: string;
  readonly start: () => Promise<AtRealTiming>;
  readonly reach: (driver: AtRealTiming) => Promise<void>;
  readonly holdOn: (driver: AtRealTiming) => Held;
  readonly previous: Shown;
  readonly row?: string;
  readonly next: Shown;
  readonly escapeIgnored?: boolean;
};

const signedIn = async (backend: FakePlanBackend): Promise<string[]> => (await backend.plan.accounts()).accounts.filter((listed) => listed.state === 'active').map((listed) => listed.label);

const accountsReadLater = (backend: FakePlanBackend): Held => hold(backend.plan, 'accountModels');

const steps: readonly Step[] = [
  {
    name: 'the catalog list after a sign-in: the sign-in waiting screen → the catalog read → the list of models of the account',
    start: () =>
      startAtRealTiming({
        options: { models: [], accounts: [account({ state: 'needs_sign_in', active: false, pinnedBy: [] })], complete: { outcome: 'signed_in', account: account({ pinnedBy: [] }), firstSignIn: false }, catalogs: { chatgpt: GPT }, dismissed: { 'invite:chatgpt': 'x' } },
        ready: 'no model connected · /login',
      }),
    reach: async (driver) => {
      await driver.submit('/login chatgpt');
      await driver.untilShown(PICKER);
      await driver.settled();
      await toRow(driver, 'chatgpt · ada@example.com');
    },
    holdOn: (driver) => accountsReadLater(driver.backend),
    previous: WAITING,
    next: CATALOG,
    escapeIgnored: true,
  },
  {
    name: 'the catalog list of an active account chosen in /login: the account list → the catalog read → the list of models of the account',
    start: () => startAtRealTiming({ accounts: [account({ pinnedBy: [] })], catalogs: { chatgpt: GPT }, dismissed: { 'invite:chatgpt': 'x' } }),
    reach: async (driver) => {
      await driver.submit('/login chatgpt');
      await driver.untilShown(PICKER);
      await driver.settled();
      await toRow(driver, 'chatgpt · ada@example.com');
    },
    holdOn: (driver) => accountsReadLater(driver.backend),
    previous: PICKER,
    row: 'chatgpt · ada@example.com',
    next: CATALOG,
  },
];

describe('the catalog list reached through /login: the screen showing stays until the list replaces it, keys during the read are dropped, esc goes back', () => {
  for (const step of steps) {
    describe(step.name, () => {
      it('1: no frame between the two screens shows the bare prompt', async () => {
        const driver = await step.start();
        await step.reach(driver);
        const held = step.holdOn(driver);
        const since = driver.mark();
        driver.app.stdin.write(KEYS.enter);
        await driver.pause(300);
        held.release();
        await driver.untilShown(step.next);
        const between = since().filter((frame) => !shows(step.previous)(frame) && !shows(step.next)(frame) && !shows(PICKER)(frame));
        expect(between.filter((frame) => inputLineOf(frame) !== '' && !frame.includes('esc'))).toEqual([]);
        driver.app.unmount();
      });

      it('2: characters, digits and enter during the read reach no draft and no later screen', async () => {
        const driver = await step.start();
        await step.reach(driver);
        const held = step.holdOn(driver);
        driver.app.stdin.write(KEYS.enter);
        await driver.pause(300);
        await driver.burst([[PROBE, 0], ['1', 10], [KEYS.enter, 10]]);
        await driver.pause(50);
        held.release();
        await driver.untilShown(step.next);
        await driver.pause(300);
        expect(shows(step.next)(driver.frameNow())).toBe(true);
        expect(driver.frameNow()).not.toContain(PROBE);
        expect(driver.backend.planCalls.filter((call) => call.route.includes('targets'))).toEqual([]);
        driver.app.unmount();
      });

      if (step.escapeIgnored === true)
        it('3: K16: esc during the read of the account models while re-signing in an existing account returns to the account list and keeps it signed in', async () => {
          const driver = await step.start();
          await step.reach(driver);
          const held = step.holdOn(driver);
          driver.app.stdin.write(KEYS.enter);
          await driver.until(() => held.calls() > 0, 'the catalog read asked');
          driver.app.stdin.write(KEYS.escape);
          await driver.pause(300);
          expect(shows(PICKER)(driver.frameNow())).toBe(true);
          held.release();
          await driver.pause(500);
          expect(shows(step.next)(driver.frameNow())).toBe(false);
          expect(await signedIn(driver.backend)).toEqual(['chatgpt']);
          driver.app.unmount();
        });

      if (step.escapeIgnored === true)
        it('3: K16: esc during Finishing the sign-in… while re-signing in an existing account returns to the account list and keeps it signed in', async () => {
          const completing = Promise.withResolvers<void>();
          const driver = await startAtRealTiming({
            options: { models: [], accounts: [account({ state: 'needs_sign_in', active: false, pinnedBy: [] })], complete: { outcome: 'signed_in', account: account({ pinnedBy: [] }), firstSignIn: false }, completeHeld: completing.promise, catalogs: { chatgpt: GPT }, dismissed: { 'invite:chatgpt': 'x' } },
            ready: 'no model connected · /login',
          });
          await step.reach(driver);
          driver.app.stdin.write(KEYS.enter);
          await driver.until(() => driver.backend.planCalls.some((call) => call.route === 'sign-in/complete'), 'the delivered sign-in completing');
          await driver.untilShown('Finishing the sign-in…');
          driver.app.stdin.write(KEYS.escape);
          await driver.pause(300);
          expect(shows(PICKER)(driver.frameNow())).toBe(true);
          completing.resolve();
          await completing.promise;
          await driver.pause(500);
          expect(shows(step.next)(driver.frameNow())).toBe(false);
          expect(await signedIn(driver.backend)).toEqual(['chatgpt']);
          driver.app.unmount();
        });

      if (step.escapeIgnored === true)
        it('3: K13: esc during Finishing the sign-in… when adding a new account cancels the sign-in and does not keep it', async () => {
          const completing = Promise.withResolvers<void>();
          const driver = await startAtRealTiming({
            options: { models: [], accounts: [account({ pinnedBy: [] })], complete: { outcome: 'signed_in', account: account({ label: 'chatgpt-2', active: false, pinnedBy: [] }), firstSignIn: false }, completeHeld: completing.promise, catalogs: { 'chatgpt-2': GPT }, dismissed: { 'invite:chatgpt': 'x' } },
            ready: 'no model connected · /login',
          });
          await driver.submit('/login chatgpt');
          await driver.untilShown(PICKER);
          await driver.settled();
          await toRow(driver, PICKER);
          await driver.step(KEYS.enter, 'chatgpt-2');
          driver.app.stdin.write(KEYS.enter);
          await driver.until(() => driver.backend.planCalls.some((call) => call.route === 'sign-in/complete'), 'the delivered sign-in completing');
          await driver.untilShown('Finishing the sign-in…');
          driver.app.stdin.write(KEYS.escape);
          await driver.pause(300);
          expect(shows(PICKER)(driver.frameNow())).toBe(true);
          completing.resolve();
          await completing.promise;
          await driver.pause(500);
          expect(shows(step.next)(driver.frameNow())).toBe(false);
          expect(await signedIn(driver.backend)).toEqual(['chatgpt']);
          driver.app.unmount();
        });

      if (step.escapeIgnored !== true)
      it('3: esc during the read shows the previous screen again and the list never opens', async () => {
        const driver = await step.start();
        await step.reach(driver);
        const held = step.holdOn(driver);
        driver.app.stdin.write(KEYS.enter);
        await driver.until(() => held.calls() > 0, 'the catalog read asked');
        driver.app.stdin.write(KEYS.escape);
        await driver.pause(100);
        expect(shows(step.previous)(driver.frameNow())).toBe(true);
        if (step.row !== undefined) expect(highlighted(step.row)(driver.frameNow())).toBe(true);
        held.release();
        await driver.pause(500);
        expect(shows(step.next)(driver.frameNow())).toBe(false);
        driver.app.unmount();
      });
    });
  }
});

describe('a run started inside /login by choosing a model of the catalog', () => {
  it('the list closes at the choice, the prompt kept for the sign-in is sent once when the target exists, and nothing typed meanwhile is sent', async () => {
    const driver = await startAtRealTiming({
      options: { models: [], accounts: [account({ state: 'needs_sign_in', active: false, pinnedBy: [] })], complete: { outcome: 'signed_in', account: account({ pinnedBy: [] }), firstSignIn: false }, catalogs: { chatgpt: GPT }, dismissed: { 'invite:chatgpt': 'x' } },
      extra: { initialPrompt: 'start here' },
      ready: 'no model connected · /login',
    });
    await driver.submit('/login chatgpt');
    await driver.untilShown(PICKER);
    await driver.settled();
    await toRow(driver, 'chatgpt · ada@example.com');
    await driver.step(KEYS.enter, CATALOG);
    await toRow(driver, 'gpt-5.1');
    const adding = hold(driver.backend.plan, 'addTarget');
    driver.app.stdin.write(KEYS.enter);
    await driver.until(() => adding.calls() > 0, 'the target asked');
    await driver.pause(20);
    expect(shows(CATALOG)(driver.frameNow())).toBe(false);
    adding.release();
    await driver.until(() => driver.backend.started.length > 0, 'the run started');
    await driver.pause(500);
    expect(driver.backend.started.map((run) => run.text)).toEqual(['start here']);
    driver.app.unmount();
  });
});

describe('the built-in model added from Add a model', () => {
  const measuring = () => {
    const gate = Promise.withResolvers<void>();
    let asked = 0;
    return {
      prepare: (backend: FakePlanBackend): void => {
        const hostOf = backend.modelsHost.bind(backend);
        Object.assign(backend, {
          modelsHost: (...given: Parameters<FakePlanBackend['modelsHost']>) => {
            const host = hostOf(...given);
            return {
              ...host,
              programModel: async (...given: Parameters<typeof host.programModel>) => {
                asked += 1;
                await gate.promise;
                return host.programModel(...given);
              },
            };
          },
        });
      },
      release: () => gate.resolve(),
      asked: () => asked,
    };
  };

  const toBuiltIn = async (driver: AtRealTiming): Promise<void> => {
    await driver.submit('/model');
    await driver.untilShown('Model settings…');
    await driver.settled();
    await toRow(driver, 'Model settings…');
    await driver.step(KEYS.enter, 'Add a model');
    await toRow(driver, 'Add a model');
    await driver.step(KEYS.enter, ADD_WAYS);
    await toRow(driver, BUILT_IN_ROW);
  };

  it('keys during its measuring wait are dropped, and esc during it shows the Add a model list again with its row highlighted', async () => {
    const wait = measuring();
    const driver = await startAtRealTiming({ options: { ...SIGNED_IN, programModel: 'apple-fm' }, prepare: wait.prepare });
    await toBuiltIn(driver);
    driver.app.stdin.write(KEYS.enter);
    await driver.until(() => wait.asked() > 0, 'the measuring asked');
    await driver.burst([[PROBE, 0], [KEYS.escape, 20]]);
    await driver.pause(100);
    expect(shows(ADD_WAYS)(driver.frameNow())).toBe(true);
    expect(highlighted(BUILT_IN_ROW)(driver.frameNow())).toBe(true);
    wait.release();
    await driver.pause(500);
    expect(shows(ADD_WAYS)(driver.frameNow())).toBe(true);
    expect(driver.frameNow()).not.toContain(PROBE);
    driver.app.unmount();
  });
});

describe('/mcp enable with the Approve question', () => {
  const CONFIG = { type: 'http', url: 'https://tracker.example/mcp' };

  it('keys during the approval wait are dropped, and esc on its wait screen shows the MCP list again with the server highlighted', async () => {
    const place = freshPlace();
    const driver = await startAtRealTiming({
      options: {
        ...SIGNED_IN,
        settingsPlace: { home: place.home, projectDir: place.project },
        mcpServers: [{ name: 'tracker', scope: 'project', transport: 'http', url: CONFIG.url, auth: 'required' }],
      },
      prepare: (backend) =>
        Object.assign(backend, {
          pendingProjectServer: async () => ({ config: CONFIG, digest: 't1' }),
          trustItems: async (server?: string) => (server === 'tracker' ? { items: [{ kind: 'mcp', name: 'tracker', config: CONFIG, digest: 't1', source: '/work/.mcp.json', change: { kind: 'new' } }], refused: [] } : { items: [], refused: [] }),
        }),
    });
    await driver.submit('/mcp');
    await driver.untilShown(ADD_HTTP_ROW);
    await driver.settled();
    await toRow(driver, 'tracker');
    await driver.step(KEYS.enter, '1. Enable');
    await toRow(driver, 'Enable');
    await driver.step(KEYS.enter, APPROVE_ROW);
    const approving = hold(driver.backend, 'approveProjectItems');
    driver.app.stdin.write(KEYS.enter);
    await driver.until(() => approving.calls() > 0, 'the approval asked');
    await driver.burst([[PROBE, 0], [KEYS.escape, 20]]);
    await driver.pause(100);
    expect(shows(ADD_HTTP_ROW)(driver.frameNow())).toBe(true);
    expect(highlighted('tracker')(driver.frameNow())).toBe(true);
    approving.release();
    await driver.pause(500);
    expect(driver.frameNow()).not.toContain(PROBE);
    expect(inputLineOf(driver.frameNow()).trimEnd()).not.toContain(PROBE);
    driver.app.unmount();
  });
});
