import { describe, expect, it, vi } from 'vitest';
import { MODEL_SETTINGS_ROW } from '@momonga/protocol';
import { SETTINGS_TITLE } from '../../src/tui/settings-screen.tsx';
import type { FakeBackendOptions } from '../fake-backend.ts';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { freshPlace } from './settings-harness.tsx';
import { startOnTerminal } from './terminal-app.tsx';
import type { TerminalApp } from './terminal-app.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const SIZE = { columns: 120, rows: 50 };
const PICKER_NOTE = 'a change applies from the next run';
const HUB_ROW = 'Models for other roles';
const ESC_KEY = '\u001b[27u';

const shows = (text: string) => (lines: string[]): boolean => lines.some((line) => line.includes(text));
const hides = (text: string) => (lines: string[]): boolean => !lines.some((line) => line.includes(text));
const chosen = (text: string) => (lines: string[]): boolean => lines.some((line) => new RegExp(`› +\\d+\\. ${text}`).test(line));

const started = async (options: FakeBackendOptions = {}, size = SIZE): Promise<TerminalApp> => {
  const place = freshPlace();
  return startOnTerminal(size, { settingsPlace: { home: place.home, projectDir: place.project }, ...options });
};

const listRows = (lines: string[]): string[] => lines.filter((line) => /^[│ ]*[› ] +\d+\. /.test(line));

describe('the model settings are reached from /model and /config, never from /models', () => {
  it('/model ends its list with a Model settings row that is not chosen, opens the Models screen, esc comes back to the list and esc again closes it', async () => {
    const app = await started();
    const picker = await app.type(`/model${KEYS.enter}`, shows(PICKER_NOTE), 'the model list opens');
    expect(listRows(picker).at(-1)).toContain(MODEL_SETTINGS_ROW);
    expect(listRows(picker).at(-1)).not.toContain('›');
    await app.type(KEYS.up, chosen(MODEL_SETTINGS_ROW), 'up wraps to the last row');
    const hub = await app.type(KEYS.enter, shows(HUB_ROW), 'the Models screen opens');
    expect(hub.join('\n')).toContain('Add a model');
    const back = await app.type(ESC_KEY, (lines) => shows(PICKER_NOTE)(lines) && hides(HUB_ROW)(lines), 'esc comes back to the model list');
    expect(back.join('\n')).toContain(MODEL_SETTINGS_ROW);
    await app.type(ESC_KEY, hides(PICKER_NOTE), 'esc again closes the model list');
    app.close();
  });

  it('/config has a Models entry that opens the Models screen, and esc comes back to the settings', async () => {
    const app = await started();
    await app.type(`/config${KEYS.enter}`, shows(SETTINGS_TITLE), 'the settings open');
    const filtered = await app.type('Models', (lines) => lines.some((line) => /› +\d+\. Models\s*│?\s*$/.test(line)), 'the Models entry is chosen by the filter');
    expect(filtered.join('\n')).not.toContain('/models');
    await app.type(KEYS.enter, shows('Wait limits'), 'the Models screen opens');
    await app.type(ESC_KEY, (lines) => shows(SETTINGS_TITLE)(lines) && hides('Wait limits')(lines), 'esc comes back to the settings');
    app.close();
  });

  it('/models is an unknown command, the slash menu for /model shows one row and /help names no /models', async () => {
    const app = await started({}, { columns: 160, rows: 200 });
    const menu = await app.type('/model', shows('choose the model'), 'the slash menu is open');
    expect(menu.join('\n')).not.toMatch(/\/models\b/);
    await app.type(`s${KEYS.enter}`, shows('unknown command /models; /help lists the commands'), 'the unknown-command answer is shown');
    const help = await app.type(`/help${KEYS.enter}`, shows('/model ['), 'the help lists the commands');
    expect(help.filter((line) => !line.includes('unknown command')).join('\n')).not.toMatch(/\/models\b/);
    app.close();
  });
});
