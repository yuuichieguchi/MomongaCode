import { describe, expect, it } from 'vitest';
import { untilFrame } from '../ink-helpers.ts';
import type { Instance } from '../ink-helpers.ts';
import { account, startPlan, submitLine } from '../fake-plan-gateway.tsx';

const ready = async (app: Instance): Promise<void> => {
  await untilFrame(app, 'mode: manual');
};

describe('the model list opens without an account catalog (cli-tui-C49, gateway-accounts-05)', () => {
  it('opens with the configured models and one row naming the account whose list could not be read', async () => {
    const { app } = await startPlan({ accounts: [account({ label: 'work' })], catalogFailures: { work: new Error('connect ECONNREFUSED') } });
    await ready(app);
    await submitLine(app, '/model');
    const picker = await untilFrame(app, 'a change applies from the next task');
    expect(picker).toContain('scripted-model');
    expect(picker).toContain('the list of models of work is not current: connect ECONNREFUSED');
    app.unmount();
  });
});
