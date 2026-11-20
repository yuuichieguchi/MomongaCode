import { describe, expect, it, vi } from 'vitest';
import { PLAN_TEST_TIMEOUT_MS, rowNumberOf, startPlan, submitLine } from '../fake-plan-gateway.tsx';
import { KEYS, untilFrame } from '../ink-helpers.ts';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const API_ROW = 'OpenAI-compatible API';

describe('an esc pressed between two overlays of a flow', () => {
  it('is forgotten when the next overlay is a text field the person answers, so the flow goes on with the value', async () => {
    const { app } = await startPlan({ accounts: [] });
    await untilFrame(app, 'mode: manual');
    await submitLine(app, '/login');
    const listed = await untilFrame(app, 'Add an API key');
    app.stdin.write(`${KEYS.down.repeat(rowNumberOf(listed, 'Add an API key') - 1)}${KEYS.enter}`);
    const apis = await untilFrame(app, API_ROW);
    app.stdin.write(`${KEYS.down.repeat(rowNumberOf(apis, API_ROW) - 1)}${KEYS.enter}`);
    app.stdin.write(KEYS.escape);
    await untilFrame(app, 'Address:');
    app.stdin.write('http://127.0.0.1:9/v1');
    await untilFrame(app, 'http://127.0.0.1:9/v1');
    app.stdin.write(KEYS.enter);
    await untilFrame(app, 'Read the key from an environment variable');
    app.unmount();
  });
});
