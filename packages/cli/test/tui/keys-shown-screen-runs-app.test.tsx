import { describe, expect, it, vi } from 'vitest';
import type { ReasoningCapability } from '@momonga/protocol';
import { KEY_SETTLE_MS } from '../../src/tui/terminal/constants.ts';
import type { FakeBackend } from '../fake-backend.ts';
import { runView } from '../fake-backend.ts';
import { IDENTITY_UNCONFIRMED, account } from '../fake-plan-gateway.tsx';
import { RESUME_PICKER_TITLE } from '../../src/tui/commands/resume.ts';
import { APPROVE_ROW } from '../../src/tui/project-items.ts';
import { CONVERSATION } from './keys-shown-screen-cases.tsx';
import type { FakePlanOptions } from '../fake-plan-gateway.tsx';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { frame } from '../tui-harness.tsx';
import { inputLineOf, shows, startAtRealTiming } from './keys-shown-screen.tsx';
import type { AtRealTiming, Shown, StartGiven } from './keys-shown-screen.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const QWEN = 'ollama/qwen3.8:27b';
const REASONING: ReasoningCapability = { control: 'reasoning_effort', lowest: 'low' };
const OPTIONS: FakePlanOptions = {
  session: { model: QWEN },
  models: [QWEN],
  billing: { [QWEN]: 'local' },
  reasoning: { [QWEN]: REASONING },
  accounts: [account()],
  history: ['an earlier prompt'],
  dismissed: { 'invite:chatgpt': 'x' },
};

const ALLOW = { optionId: 'o1', name: 'Allow once', kind: 'allow_once' };
const REJECT = { optionId: 'o3', name: 'Reject once', kind: 'reject_once' };
const APPROVAL = 'Permission requested: Write out.txt';

const cancels = (backend: FakeBackend): string[] => backend.calls.filter((call) => call.startsWith('cancel:'));
const approvals = (backend: FakeBackend): string[] => backend.calls.filter((call) => call.startsWith('approve:'));

type Nested = { readonly name: string; readonly run: (driver: AtRealTiming) => Promise<void> };

const closedBy = async (driver: AtRealTiming, opened: (frame: string) => boolean, closing: string): Promise<void> => {
  await driver.untilShown(opened);
  await driver.settled();
  driver.app.stdin.write(closing);
  await driver.untilShown((shown) => !opened(shown));
  await driver.settled();
};

const nestedLists: readonly Nested[] = [
  { name: 'no nested list', run: async () => undefined },
  {
    name: '/mode closed with esc',
    run: async (driver) => {
      await driver.submit('/mode');
      await closedBy(driver, (shown) => shown.includes('Permission mode'), KEYS.escape);
    },
  },
  {
    name: '/mode with a mode chosen',
    run: async (driver) => {
      await driver.submit('/mode');
      await closedBy(driver, (shown) => shown.includes('Permission mode'), KEYS.enter);
    },
  },
  {
    name: '/logout cancelled',
    run: async (driver) => {
      await driver.submit('/logout');
      await closedBy(driver, (shown) => shown.includes('Sign out') && /\d+\. /.test(shown), KEYS.escape);
    },
  },
  {
    name: 'ctrl+r history search closed with esc',
    run: async (driver) => {
      driver.app.stdin.write(KEYS.ctrlR);
      await closedBy(driver, (shown) => shown.includes('an earlier prompt'), KEYS.escape);
    },
  },
];

const working = async (options: FakePlanOptions = OPTIONS): Promise<AtRealTiming> => {
  const driver = await startAtRealTiming(options);
  await driver.submit('long task');
  await driver.until(() => driver.backend.started.length === 1, 'the run started');
  await driver.settled();
  return driver;
};

const ask = (backend: FakeBackend): void => {
  backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Write', kind: 'edit', title: 'Write out.txt', rawInput: { file_path: 'out.txt', content: 'x' } }));
  backend.emit(frame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'c1', subjectDigest: 'd', reason: 'edits require approval', options: [ALLOW, REJECT], shown: { title: 'approval', input: {} } }));
};

const USAGE_LIMIT = runView({ status: 'STOPPED', stopReason: 'usage_limit' as never, error: { code: 'plan_usage_limit', message: 'Manage usage', plan: { profile: 'chatgpt', account: 'chatgpt' } } as never });

describe('while a run is working and no screen of a flow is showing, a key acts on the prompt at once', () => {
  for (const nested of nestedLists) {
    it(`esc stops the run (${nested.name})`, async () => {
      const driver = await working();
      await nested.run(driver);
      driver.app.stdin.write(KEYS.escape);
      await driver.pause(300);
      expect(cancels(driver.backend)).toEqual(['cancel:run-1']);
      driver.app.unmount();
    });

    it(`typed characters appear in the prompt at once (${nested.name})`, async () => {
      const driver = await working();
      await nested.run(driver);
      driver.app.stdin.write('hello');
      await driver.pause(50);
      expect(inputLineOf(driver.frameNow()).trimEnd()).toBe('> hello');
      driver.app.unmount();
    });
  }
});

type RunPanel = {
  readonly name: string;
  readonly given?: FakePlanOptions;
  readonly appear: (driver: AtRealTiming) => Promise<void>;
  readonly shown: Shown;
  readonly answer: string;
  readonly answered: (driver: AtRealTiming) => boolean;
};

const FORM = { key: 'profile', mode: 'form', message: 'Tell me about you', requestedSchema: { type: 'object', properties: { name: { type: 'string', title: 'Your name' } }, required: ['name'] } };
const HELD = { type: 'tool.held', callId: 'c1', approvalId: 'ap1', reason: 'needs a person', footprint: { reads: [], writes: [] } };
const childFrame = (event: Record<string, unknown>) => frame({ runId: 'child-1', ...event });
const touchesAp1 = (driver: AtRealTiming): boolean => driver.backend.calls.some((call) => call.includes('ap1'));
const ELICITATION = 'MCP server calc asks for input';

const elicited = (driver: AtRealTiming): void => {
  driver.backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'p1', name: 'mcp__calc__ask', kind: 'other', title: 'mcp__calc__ask {}', rawInput: {} }));
  driver.backend.emit(frame({ type: 'tool.elicitation.requested', inputId: 'in1', callId: 'c1', server: 'calc', requests: [FORM] }));
};

const subagent = (driver: AtRealTiming) => {
  const follow = driver.backend.following();
  follow.onChildStarted('reviewer', 'child-1', 0, 'scripted/scripted-model', undefined);
  return follow;
};

const runPanels: readonly RunPanel[] = [
  { name: 'the tool approval', appear: async (driver) => ask(driver.backend), shown: APPROVAL, answer: '1', answered: (driver) => approvals(driver.backend).includes('approve:ap1:o1') },
  {
    name: 'the effect-unknown approval',
    appear: async (driver) => {
      driver.backend.emit(frame({ type: 'tool.call', callId: 'c1', providerCallId: 'c1', name: 'Bash', kind: 'execute', title: 'sleep 60', rawInput: { command: 'sleep 60' } }));
      driver.backend.emit(frame({ type: 'tool.unknown.requested', approvalId: 'ap1', callIds: ['c1'], options: [ALLOW, REJECT] }));
    },
    shown: '1. Allow once',
    answer: '1',
    answered: touchesAp1,
  },
  {
    name: 'the held approval when the run waits for it',
    appear: async (driver) => {
      ask(driver.backend);
      driver.backend.emit(frame(HELD));
      await driver.pause(50);
      driver.backend.emit(frame({ type: 'run.status', from: 'RUNNING', to: 'WAITING_HUMAN' }));
    },
    shown: APPROVAL,
    answer: '1',
    answered: touchesAp1,
  },
  {
    name: 'a subagent approval',
    appear: async (driver) => {
      const follow = subagent(driver);
      follow.onChildEvent(childFrame({ type: 'tool.call', callId: 'k1', providerCallId: 'p-k1', name: 'Bash', kind: 'execute', title: 'Bash rm -r build', rawInput: {} }), 'reviewer');
      follow.onChildEvent(childFrame({ type: 'tool.permission.requested', approvalId: 'ap1', callId: 'k1', subjectDigest: 'd', reason: 'asks', options: [ALLOW], shown: { title: 'Bash rm -r build', input: {} } }), 'reviewer');
    },
    shown: 'reviewer: Bash rm -r build',
    answer: '1',
    answered: touchesAp1,
  },
  {
    name: 'a subagent elicitation at its fields stage',
    appear: async (driver) => {
      const follow = subagent(driver);
      follow.onChildEvent(childFrame({ type: 'tool.call', callId: 'k1', providerCallId: 'p1', name: 'mcp__calc__ask', kind: 'other', title: 'mcp__calc__ask {}', rawInput: {} }), 'reviewer');
      follow.onChildEvent(childFrame({ type: 'tool.elicitation.requested', inputId: 'in1', callId: 'k1', server: 'calc', requests: [FORM] }), 'reviewer');
    },
    shown: ELICITATION,
    answer: 'Ada',
    answered: (driver) => driver.frameNow().includes('Ada'),
  },
  { name: 'the MCP elicitation at its fields stage', appear: async (driver) => elicited(driver), shown: ELICITATION, answer: 'Ada', answered: (driver) => driver.frameNow().includes('Ada') },
  {
    name: 'the plan-block list at the end of the run',
    given: { ...OPTIONS, accounts: [account({ label: 'work', state: 'plan_disabled' })] },
    appear: async (driver) => driver.backend.finish(runView({ status: 'FAILED', error: { code: 'plan_use_not_enabled', message: 'Plan use is not enabled for this account.', plan: { profile: 'chatgpt', account: 'work' } } as never })),
    shown: 'Enable ChatGPT plan use',
    answer: '2',
    answered: (driver) => driver.frameNow().includes('OpenAI-compatible API'),
  },
  { name: 'the usage-limit list at the end of the run', appear: async (driver) => driver.backend.finish(USAGE_LIMIT), shown: 'Manage usage', answer: KEYS.enter, answered: (driver) => driver.backend.openedUrls.length === 1 },
];

describe('7: a panel that appears on its own during a run takes no key pressed in the 300 ms before it appeared, and takes keys once drawn and settled', () => {
  for (const panel of runPanels) {
    for (const nested of nestedLists) {
      for (const [name, early] of [['a digit', '1'], ['enter', KEYS.enter], ['esc', KEYS.escape]] as const) {
        it(`${panel.name}: ${name} before it appears does not answer it; its answer after the settle does (${nested.name})`, async () => {
          const driver = await working(panel.given);
          await nested.run(driver);
          driver.app.stdin.write(early);
          await driver.pause(300);
          await panel.appear(driver);
          await driver.untilShown(panel.shown);
          await driver.pause(KEY_SETTLE_MS * 2);
          expect(panel.answered(driver)).toBe(false);
          expect(shows(panel.shown)(driver.frameNow())).toBe(true);
          driver.app.stdin.write(panel.answer);
          await driver.pause(300);
          expect(panel.answered(driver)).toBe(true);
          driver.app.unmount();
        });
      }
    }
  }

  for (const nested of nestedLists.filter((candidate) => candidate.name !== 'no nested list')) {
    it(`the usage-limit list at the end of the run is shown although esc was pressed after the nested list closed (${nested.name})`, async () => {
      const driver = await working();
      await nested.run(driver);
      driver.app.stdin.write(KEYS.escape);
      await driver.pause(300);
      driver.backend.finish(USAGE_LIMIT);
      await driver.pause(500);
      expect(driver.frameNow()).toContain('Manage usage');
      expect(cancels(driver.backend)).toEqual(['cancel:run-1']);
      driver.app.unmount();
    });
  }
});

type LaunchPanel = {
  readonly name: string;
  readonly given: (early: string) => StartGiven;
  readonly shown: Shown;
  readonly answer: string;
  readonly answered: (driver: AtRealTiming) => boolean;
};

const ITEMS = { items: [{ kind: 'hook', event: 'PreToolUse', group: { matcher: 'Bash', hooks: [{ type: 'command' as const, command: './scripts/check.sh --fix' }] }, digest: 'd1', source: '/work/.momonga/settings.json', change: { kind: 'new' } }], refused: [] } as never;

const launchPanels: readonly LaunchPanel[] = [
  { name: 'the folder trust panel', given: (early) => ({ options: { ...OPTIONS, trust: { path: '/work/project', decision: null } }, ready: 'Do you trust the files in /work/project?', early }), shown: 'Do you trust the files in /work/project?', answer: `2${KEYS.enter}`, answered: (driver) => driver.backend.calls.some((call) => call.startsWith('trust:')) },
  { name: 'the trust items question', given: (early) => ({ options: { ...OPTIONS, trustItems: ITEMS }, ready: APPROVE_ROW, early }), shown: APPROVE_ROW, answer: KEYS.enter, answered: (driver) => driver.backend.calls.some((call) => call.startsWith('approve:')) },
  { name: 'the welcome list', given: (early) => ({ options: { models: [], accounts: [], callbackArrives: false }, ready: 'Continue with ChatGPT', early }), shown: 'Continue with ChatGPT', answer: KEYS.enter, answered: (driver) => driver.backend.planCalls.some((call) => call.route === 'sign-in/begin') },
  { name: 'the conversation pick', given: (early) => ({ options: { ...OPTIONS, conversations: [CONVERSATION] }, extra: { reopen: { kind: 'pick' } }, ready: RESUME_PICKER_TITLE, early }), shown: RESUME_PICKER_TITLE, answer: KEYS.enter, answered: (driver) => driver.backend.calls.some((call) => call.startsWith('resume:')) },
];

describe('7: a panel that appears on its own at launch takes no key pressed before it appeared, and takes keys once drawn and settled', () => {
  for (const panel of launchPanels) {
    for (const [name, early] of [['a digit', '2'], ['enter', KEYS.enter], ['esc', KEYS.escape]] as const) {
      it(`${panel.name}: ${name} before it appears does not answer it; its answer after the settle does`, async () => {
        const driver = await startAtRealTiming(panel.given(early));
        await driver.pause(1500);
        expect(panel.answered(driver)).toBe(false);
        expect(shows(panel.shown)(driver.frameNow())).toBe(true);
        driver.app.stdin.write(panel.answer);
        await driver.pause(300);
        expect(panel.answered(driver)).toBe(true);
        driver.app.unmount();
      });
    }
  }

  it('esc on Finishing the sign-in… once it is drawn cancels the sign-in: the waiting screen closes and the sign-in is not kept', async () => {
    const completing = Promise.withResolvers<void>();
    const driver = await startAtRealTiming({ ...OPTIONS, accounts: [], complete: IDENTITY_UNCONFIRMED, completeHeld: completing.promise });
    await driver.submit('/login chatgpt');
    await driver.until(() => driver.backend.planCalls.some((call) => call.route === 'sign-in/complete'), 'the completion asked');
    await driver.untilShown('Finishing the sign-in…');
    driver.app.stdin.write(KEYS.escape);
    await driver.untilShown((frame) => !frame.includes('Finishing the sign-in…'));    completing.resolve();
    await completing.promise;
    await driver.pause(500);
    expect(driver.app.frames.some((frame) => frame.includes('Save this account'))).toBe(false);
    expect((await driver.backend.plan.accounts()).accounts.filter((listed) => listed.state === 'active')).toEqual([]);
    driver.app.unmount();
  });

  for (const [name, early] of [['a digit', '2'], ['enter', KEYS.enter]] as const) {
    it(`the identity question over the sign-in waiting screen: ${name} before it appears does not answer it; Save after the settle does`, async () => {
      const completing = Promise.withResolvers<void>();
      const driver = await startAtRealTiming({ ...OPTIONS, accounts: [], complete: IDENTITY_UNCONFIRMED, completeHeld: completing.promise });
      await driver.submit('/login chatgpt');
      await driver.until(() => driver.backend.planCalls.some((call) => call.route === 'sign-in/complete'), 'the completion asked');
      driver.app.stdin.write(early);
      await driver.pause(300);
      completing.resolve();
      await driver.untilShown('Save this account');
      await driver.pause(1500);
      const completions = (): number => driver.backend.planCalls.filter((call) => call.route === 'sign-in/complete').length;
      const cancelled = (): boolean => driver.backend.planCalls.some((call) => call.route === 'sign-in/cancel');
      expect(completions()).toBe(1);
      expect(cancelled()).toBe(false);
      expect(driver.frameNow()).toContain('Save this account');
      driver.app.stdin.write(`2${KEYS.enter}`);
      await driver.pause(300);
      expect(completions()).toBe(2);
      driver.app.unmount();
    });
  }
});
