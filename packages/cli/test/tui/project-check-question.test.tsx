import { describe, expect, it } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import { App } from '../../src/tui/app.tsx';
import { DECLINE_CHECK_ROW, useCheckRow } from '../../src/tui/project-check.ts';
import { fakeBackend } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { KEYS, renderObservable, settleAtOnce, TEST_KEY_SETTLE_MS, untilFrame } from '../ink-helpers.ts';
import { fakeScreenTerminal } from './screen-fakes.ts';

const NPM_TEST = { source: 'package.json', command: 'npm test' } as const;

const start = (options: FakeBackendOptions) => {
  const backend = fakeBackend(options);
  const app = renderObservable(<App backend={backend} terminal={fakeScreenTerminal({ columns: 120, rows: 40 })} initialMode={undefined} now={Date.now} timers={settleAtOnce(systemTiming)} keySettleMs={TEST_KEY_SETTLE_MS} onExit={() => undefined} />);
  return { backend, app };
};

describe('the check a trusted folder declares is proposed at the start', () => {
  it('stores the accepted check for the folder', async () => {
    const { backend, app } = start({ checkProposal: { ask: true, checks: [NPM_TEST] } });
    const question = await untilFrame(app, useCheckRow(NPM_TEST));
    expect(question).toContain(DECLINE_CHECK_ROW);
    app.stdin.write(KEYS.enter);
    await backend.called('check:{"commands":["npm test"]}');
    await untilFrame(app, 'mode: manual');
    app.unmount();
  });

  it('stores nothing when the question is left, and asks nothing when there is no proposal', async () => {
    const left = start({ checkProposal: { ask: true, checks: [NPM_TEST] } });
    await untilFrame(left.app, useCheckRow(NPM_TEST));
    left.app.stdin.write(KEYS.escape);
    await untilFrame(left.app, 'mode: manual');
    expect(left.backend.calls.some((call) => call.startsWith('check:'))).toBe(false);
    left.app.unmount();

    const none = start({});
    const frame = await untilFrame(none.app, 'mode: manual');
    expect(frame).not.toContain(DECLINE_CHECK_ROW);
    none.app.unmount();
  });
});
