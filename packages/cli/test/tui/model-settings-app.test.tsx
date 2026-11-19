import { describe, expect, it, vi } from 'vitest';
import { MODEL_SETTINGS_ROW } from '@momonga/protocol';
import { SETTINGS_TITLE } from '../../src/tui/settings-screen.tsx';
import { KEYS, TUI_TEST_TIMEOUT_MS, untilFrame } from '../ink-helpers.ts';
import { command, freshPlace, press, startAt } from './settings-harness.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const PICKER_NOTE = 'a change applies from the next run';
const HUB_ROW = 'Models for other roles';

const lastListRow = (frame: string): string => frame.split('\n').filter((line) => /^\s*[›]?\s*\d+\. /.test(line.replace(/^[│|]\s?/, ''))).at(-1) ?? '';

describe('the model settings are reached from /model and /config, never from /models', () => {
  it('/model ends its list with a Model settings row that is not chosen, opens the Models screen, and esc comes back to the list', async () => {
    const started = await startAt(freshPlace());
    const picker = await command(started, '/model', PICKER_NOTE);
    expect(lastListRow(picker)).toContain(MODEL_SETTINGS_ROW);
    expect(lastListRow(picker)).not.toContain('›');
    await press(started, KEYS.up, new RegExp(`› +\\d+\\. ${MODEL_SETTINGS_ROW}`));
    const hub = await press(started, KEYS.enter, HUB_ROW);
    expect(hub).toContain('Add a model');
    const back = await press(started, KEYS.escape, PICKER_NOTE);
    expect(back).toContain(MODEL_SETTINGS_ROW);
    expect(back).not.toContain(HUB_ROW);
    started.app.unmount();
  });

  it('/config has a Models entry that opens the Models screen, and esc comes back to the settings', async () => {
    const started = await startAt(freshPlace());
    await command(started, '/config', SETTINGS_TITLE);
    await press(started, 'Models', 'filter: Models');
    const filtered = await untilFrame(started.app, (frame) => /› +\d+\. Models\s*│?\s*$/m.test(frame));
    expect(filtered).not.toContain('/models');
    const hub = await press(started, KEYS.enter, HUB_ROW);
    expect(hub).toContain('Wait limits');
    await press(started, KEYS.escape, SETTINGS_TITLE);
    started.app.unmount();
  });

  it('/models is an unknown command and the slash menu for /model shows one row', async () => {
    const started = await startAt(freshPlace());
    const menu = await press(started, '/model', (frame) => frame.includes('choose the model'));
    expect(menu).not.toMatch(/\/models\b/);
    await press(started, `s${KEYS.enter}`, 'unknown command /models; /help lists the commands');
    const help = await command(started, '/help', '/model ');
    expect(help.slice(help.indexOf('Commands'))).not.toMatch(/\/models\b/);
    started.app.unmount();
  });
});
