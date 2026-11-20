import { describe, expect, it, vi } from 'vitest';
import { PLAN_TEST_TIMEOUT_MS, rowNumberOf, startPlan, submitLine } from '../fake-plan-gateway.tsx';
import { KEYS, untilFrame } from '../ink-helpers.ts';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const API_ROW = 'OpenAI-compatible API';

describe('an esc pressed right after enter on a list row is not remembered for a later screen', () => {
  it('acts on the screen showing: the list of APIs shows again, no address field is left open and nothing is saved', async () => {
    const { app, backend } = await startPlan({ accounts: [] });
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login');
    const listed = await untilFrame(app, 'Add an API key');
    app.stdin.write(`${KEYS.down.repeat(rowNumberOf(listed, 'Add an API key') - 1)}${KEYS.enter}`);
    const apis = await untilFrame(app, API_ROW);
    app.stdin.write(`${KEYS.down.repeat(rowNumberOf(apis, API_ROW) - 1)}${KEYS.enter}`);
    app.stdin.write(KEYS.escape);
    const back = await untilFrame(app, (shown) => shown.includes(API_ROW) && !shown.includes('Address:'));
    expect(back).toContain(API_ROW);
    expect(backend.calls.filter((call) => call.startsWith('secret:'))).toEqual([]);
    app.unmount();
  });
});
