import { describe, expect, it } from 'vitest';
import { systemTiming } from '@momonga/foundation';
import { App } from '../../src/tui/app.tsx';
import { APPROVE_ROW, NOT_NOW_ROW } from '../../src/tui/project-items.ts';
import { fakeBackend } from '../fake-backend.ts';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { KEYS, renderObservable, settleAtOnce, TEST_KEY_SETTLE_MS, untilFrame } from '../ink-helpers.ts';
import { fakeScreenTerminal } from './screen-fakes.ts';

const GROUP = { matcher: 'Bash', hooks: [{ type: 'command' as const, command: './scripts/check.sh --fix' }] };

const start = (options: FakeBackendOptions) => {
  const backend = fakeBackend(options);
  const app = renderObservable(<App backend={backend} terminal={fakeScreenTerminal({ columns: 120, rows: 40 })} initialMode={undefined} now={Date.now} timers={settleAtOnce(systemTiming)} keySettleMs={TEST_KEY_SETTLE_MS} onExit={() => undefined} />);
  return { backend, app };
};

describe('a hook group or mandate file of a trusted folder that is new or changed is asked about at the start', () => {
  it('shows the hook group in full and records its digest when the person approves it', async () => {
    const { backend, app } = start({ projectItems: { hooks: [{ event: 'PreToolUse', group: GROUP, digest: 'd1', source: '/work/.momonga/settings.json' }] } });
    const question = await untilFrame(app, APPROVE_ROW);
    expect(question).toContain('PreToolUse hook group');
    expect(question).toContain('/work/.momonga/settings.json');
    expect(question).toContain('./scripts/check.sh --fix');
    expect(question).toContain(NOT_NOW_ROW);
    app.stdin.write(KEYS.enter);
    await backend.called('approve:{"hooks":["d1"]}');
    await untilFrame(app, 'mode: manual');
    app.unmount();
  });

  it('says a mandate file changed since it was approved, shows it, and leaves it unapproved on Not now', async () => {
    const { backend, app } = start({ projectItems: { hooks: [], mandate: { file: '/work/.momonga/mandate.json', found: true, document: { deny: ['Bash(curl:*)'] }, digest: 'm1', approval: 'changed' } } });
    const question = await untilFrame(app, APPROVE_ROW);
    expect(question).toContain('changed since you approved it');
    expect(question).toContain('Bash(curl:*)');
    app.stdin.write(KEYS.escape);
    await untilFrame(app, 'mode: manual');
    expect(backend.calls.some((call) => call.startsWith('approve:'))).toBe(false);
    app.unmount();
  });
});
