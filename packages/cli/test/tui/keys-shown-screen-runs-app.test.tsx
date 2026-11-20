import { describe, expect, it, vi } from 'vitest';
import type { ReasoningCapability } from '@momonga/protocol';
import { KEY_SETTLE_MS } from '../../src/tui/terminal/constants.ts';
import type { FakeBackend } from '../fake-backend.ts';
import { runView } from '../fake-backend.ts';
import { account } from '../fake-plan-gateway.tsx';
import type { FakePlanOptions } from '../fake-plan-gateway.tsx';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { frame } from '../tui-harness.tsx';
import { inputLineOf, startAtRealTiming } from './keys-shown-screen.tsx';
import type { AtRealTiming } from './keys-shown-screen.tsx';

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

const working = async (): Promise<AtRealTiming> => {
  const driver = await startAtRealTiming(OPTIONS);
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

describe('a panel that appears on its own takes no key pressed before it appeared, and takes keys once drawn and settled', () => {
  for (const nested of nestedLists) {
    for (const [name, early] of [['a digit', '1'], ['enter', KEYS.enter], ['esc', KEYS.escape]] as const) {
      it(`the tool approval: ${name} pressed 300 ms before it appears does not answer it, a digit after the settle does (${nested.name})`, async () => {
        const driver = await working();
        await nested.run(driver);
        driver.app.stdin.write(early);
        await driver.pause(300);
        ask(driver.backend);
        await driver.untilShown(APPROVAL);
        await driver.pause(KEY_SETTLE_MS * 2);
        expect(approvals(driver.backend)).toEqual([]);
        expect(driver.frameNow()).toContain(APPROVAL);
        driver.app.stdin.write('1');
        await driver.pause(100);
        expect(approvals(driver.backend)).toEqual(['approve:ap1:o1']);
        driver.app.unmount();
      });
    }
  }

  for (const nested of nestedLists.filter((candidate) => candidate.name !== 'no nested list')) {
    it(`the usage-limit list at the end of the run is shown and takes keys after its settle (${nested.name})`, async () => {
      const driver = await working();
      await nested.run(driver);
      driver.backend.finish(USAGE_LIMIT);
      await driver.pause(500);
      expect(driver.frameNow()).toContain('Manage usage');
      driver.app.unmount();
    });

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
