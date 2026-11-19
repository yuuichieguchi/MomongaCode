import { describe, expect, it, vi } from 'vitest';
import type { StartupConfig } from '../../src/tui/startup.tsx';
import { PLAN_TEST_TIMEOUT_MS, startPlan } from '../fake-plan-gateway.tsx';
import { KEYS, untilFrame } from '../ink-helpers.ts';
import { start } from '../tui-harness.tsx';

vi.setConfig({ testTimeout: PLAN_TEST_TIMEOUT_MS });

const STARTUP: StartupConfig = { version: '1.2.3', home: '/Users/ada' };
const VERSION = 'MomongaCode v1.2.3';
const TRUST_TITLE = 'Do you trust the files in /work/project?';
const TRUST_ROW = '1. Yes, I trust this folder';
const DEVSTRAL = 'ollama/devstral-small-2:latest';
const QWEN = 'ollama/qwen3.8:27b';
const WELCOME_TITLE = 'Connect a model to start';

const modelLinesOf = (frame: string): string[] => frame.split('\n').flatMap((row) => {
  const at = row.indexOf('model:');
  return at === -1 ? [] : [row.slice(at).replace(/[\s│]+$/, '')];
});

describe('the start figure while the trust question is on the screen says nothing about the model', () => {
  it('with a configured model, the trust frame has no model line, and after trusting the one start figure shows the configured model', async () => {
    const { app, backend } = await start({ session: { model: DEVSTRAL }, models: [DEVSTRAL, QWEN], chain: [DEVSTRAL, QWEN], trust: { path: '/work/project', decision: null } }, { startup: STARTUP });
    const asked = await untilFrame(app, (shown) => shown.includes(TRUST_TITLE) && shown.includes(TRUST_ROW) && shown.includes(VERSION));
    expect(modelLinesOf(asked)).toEqual([]);
    for (const frame of app.frames.filter((shown) => shown.includes(TRUST_TITLE))) expect(modelLinesOf(frame)).toEqual([]);
    app.stdin.write(KEYS.enter);
    const trusted = await untilFrame(app, (shown) => shown.includes('mode: manual') && shown.includes('model: ollama/devstral-small-2'));
    expect(backend.calls).toContain('trust:trusted');
    expect(modelLinesOf(trusted)).toEqual(['model: ollama/devstral-small-2']);
    expect(trusted.split(VERSION)).toHaveLength(2);
    app.unmount();
  });

  it('with no configured model, the trust frame has no model line, and after trusting the welcome phase says that no model is connected', async () => {
    const { app } = await startPlan({ models: [], accounts: [], trust: { path: '/work/project', decision: null } }, { startup: STARTUP });
    const asked = await untilFrame(app, (shown) => shown.includes(TRUST_ROW) && shown.includes(VERSION));
    expect(modelLinesOf(asked)).toEqual([]);
    app.stdin.write(KEYS.enter);
    const welcome = await untilFrame(app, (shown) => shown.includes(WELCOME_TITLE) && shown.includes(VERSION));
    expect(modelLinesOf(welcome)).toEqual(['model: not connected']);
    expect(welcome.split(VERSION)).toHaveLength(2);
    app.unmount();
  });
});
