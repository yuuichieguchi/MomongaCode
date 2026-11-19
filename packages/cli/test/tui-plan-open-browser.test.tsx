import { describe, expect, it, vi } from 'vitest';
import { runView } from './fake-backend.ts';
import { untilFrame, untilOutput, withoutLinks } from './ink-helpers.ts';
import { runStarted } from './tui-harness.tsx';
import { AUTHORIZATION_URL, PLAN_TEST_TIMEOUT_MS, account, choose, eventually, startPlan, submitLine } from './fake-plan-gateway.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

describe('the TUI starts the browser through the opener port and hears of a failed launch (P-C7)', () => {
  it('a reported launch failure adds the copy-manually line to the waiting screen', async () => {
    const { app } = await startPlan({ accounts: [], callbackArrives: false, openUrlFailure: new Error('no opener') });
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login chatgpt');
    const screen = await untilFrame(app, 'Could not open the browser (no opener). Copy the URL and continue manually.');
    expect(screen.replace(/\s+/g, '')).toContain(AUTHORIZATION_URL);
    app.unmount();
  });

  it('Manage usage reports a failed launch as an info line', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ paused: {} })], openUrlFailure: new Error('no opener') });
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    backend.finish(runView({ status: 'STOPPED', stopReason: 'usage_limit' as never, error: { code: 'plan_usage_limit', message: 'Manage usage', plan: { profile: 'chatgpt', account: 'chatgpt' } } as never }));
    await choose(app, 'Manage usage');
    await untilOutput(app, (shown) => withoutLinks(shown).includes('Could not open the browser (no opener). Manage usage: https://chatgpt.com/settings/usage'));
    expect(backend.openUrlCalls).toHaveLength(1);
    app.unmount();
  });

  it('Manage usage hears of a failed launch until the next key press, and not after it', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ paused: {} })] });
    await untilFrame(app, 'mode: manual');
    await runStarted(backend, app, 'go');
    backend.finish(runView({ status: 'STOPPED', stopReason: 'usage_limit' as never, error: { code: 'plan_usage_limit', message: 'Manage usage', plan: { profile: 'chatgpt', account: 'chatgpt' } } as never }));
    await choose(app, 'Manage usage');
    await eventually(() => backend.openUrlCalls.length === 1, 'the opener was asked');
    const watch = backend.openUrlCalls[0]?.watch;
    expect(watch?.aborted).toBe(false);
    app.stdin.write('x');
    await eventually(() => watch?.aborted === true, 'the next key press ended the watch');
    app.unmount();
  });

  it('the watch signal handed by the sign-in flow aborts when the flow ends', async () => {
    const { app, backend } = await startPlan({ accounts: [], callbackArrives: true });
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login chatgpt');
    await untilOutput(app, 'Signed in as chatgpt (ada@example.com)');
    expect(backend.openUrlCalls).toHaveLength(1);
    expect(backend.openUrlCalls[0]?.watch?.aborted).toBe(true);
    app.unmount();
  });
});
