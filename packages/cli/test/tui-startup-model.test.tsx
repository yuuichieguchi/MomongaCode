import { describe, expect, it } from 'vitest';
import type { StartupConfig } from '../src/tui/startup.tsx';
import { account, startPlan, submitLine } from './fake-plan-gateway.tsx';
import { KEYS, untilFrame, untilOutput } from './ink-helpers.ts';
import { start } from './tui-harness.tsx';

const config: StartupConfig = { version: '1.2.3', home: '/Users/ada' };

const DEVSTRAL = 'ollama/devstral-small-2:latest';
const GEMMA = 'ollama/gemma-3-4b:latest';
const QWEN = 'ollama/qwen3.8:27b';

describe('the model on the start screen', () => {
  it('shows the model by its display name, and no fallback line', async () => {
    const { app } = await start({ session: { model: DEVSTRAL }, models: [DEVSTRAL, QWEN], chain: [DEVSTRAL, QWEN] }, { startup: config }, { columns: 80, rows: 16 });
    const screen = await untilFrame(app, 'model: ollama/devstral-small-2');
    expect(screen).not.toContain(`model: ${DEVSTRAL}`);
    expect(screen).not.toContain('fallback:');
    app.unmount();
  });

  it('says that no model is connected when none is', async () => {
    const { app } = await startPlan({ models: [], accounts: [account({ state: 'needs_sign_in', active: false, pinnedBy: [] })] }, { startup: config });
    const banner = await untilOutput(app, 'model: not connected  (use /login)');
    expect(banner).not.toContain('fallback:');
    await submitLine(app, 'hello');
    await untilFrame(app, 'No model is connected. Use /login to connect one.');
    app.unmount();
  });

  it('names the stored model of a session that is not configured any more, as stored, and opens the list when a message is sent', async () => {
    const { app, backend } = await start({ session: { model: GEMMA }, models: [QWEN] }, { startup: config });
    const screen = await untilOutput(app, `The model "${GEMMA}" of this session is not configured any more. Choose another with /model.`);
    expect(screen).toContain(`model: ${GEMMA}`);
    app.stdin.write('hello');
    await untilFrame(app, '> hello');
    app.stdin.write(KEYS.enter);
    const list = await untilFrame(app, 'a change applies from the next run');
    expect(list).toContain('Models');
    expect(list).toContain('qwen3.8:27b');
    expect(backend.started).toEqual([]);
    app.unmount();
  });
});
