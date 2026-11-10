import { describe, expect, it, vi } from 'vitest';
import { runView } from './fake-backend.ts';
import { untilFrame, untilOutput } from './ink-helpers.ts';
import type { Instance } from './ink-helpers.ts';
import { runStarted } from './tui-harness.tsx';
import { PLAN_TEST_TIMEOUT_MS, account, choose, eventually, startPlan, submitLine } from './fake-plan-gateway.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const SENTENCE = 'Complete eligible AI requests in this app with usage included in your ChatGPT plan or credits balance.';

const ready = async (app: Instance): Promise<void> => {
  await untilFrame(app, 'mode: default');
};

const expired = () => runView({ status: 'FAILED', error: { code: 'sign_in_required', message: 'ChatGPT sign-in expired' } });

const signInAgain = async (app: Instance): Promise<void> => {
  await submitLine(app, '/login chatgpt');
  await choose(app, 'work · w@example.com');
  await untilFrame(app, SENTENCE);
  await choose(app, 'Continue with ChatGPT');
};

describe('resubmit after /login (O-R5-4 S1)', () => {
  it('retries the prompt whose run failed with sign_in_required once the sign-in completes, with a notice', async () => {
    const { app, backend } = await startPlan({ accounts: [account({ label: 'work', email: 'w@example.com', state: 'needs_sign_in' })] });
    await ready(app);
    await runStarted(backend, app, 'fix the failing test');
    backend.finish(expired());
    await untilOutput(app, 'ChatGPT sign-in expired');
    await signInAgain(app);
    await untilOutput(app, 'Signed in again. Retrying your last prompt.');
    await eventually(() => backend.started.length === 2, 'the resubmitted run');
    expect(backend.started[1]?.text).toBe('fix the failing test');
    app.unmount();
  });
});

describe('TUI resume honours the answer of the gateway (P-C8)', () => {
  it('TUI resume honours resumed:false', async () => {
    const { app } = await startPlan({ accounts: [account({ label: 'work', email: 'w@example.com', paused: {} })], resumeAnswer: { resumed: false } });
    await ready(app);
    await submitLine(app, '/login chatgpt');
    await choose(app, 'Resume plan use for work');
    const output = await untilOutput(app, 'work is not paused');
    expect(output).not.toContain('work: plan use resumed');
    app.unmount();
  });
});
