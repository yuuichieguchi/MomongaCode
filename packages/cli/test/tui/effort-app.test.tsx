import { MODEL_SETTINGS_ROW } from '@momonga/protocol';
import { describe, expect, it, vi } from 'vitest';
import { SCRIPTED_MODEL } from '@momonga/testkit';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { freshPlace, stored, writeSettings } from './settings-harness.tsx';
import type { Place } from './settings-harness.tsx';
import { startOnTerminal } from './terminal-app.tsx';
import type { TerminalApp } from './terminal-app.tsx';
import type { FakeBackendOptions } from '../fake-backend.ts';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const SIZE = { columns: 100, rows: 30 };
const DECLARED: FakeBackendOptions['reasoning'] = { [SCRIPTED_MODEL]: { control: 'reasoning_effort', lowest: 'low' } };
const shows = (text: string) => (lines: string[]): boolean => lines.some((line) => line.includes(text));

const OTHER = 'scripted/other-model';
const REASONING = { control: 'reasoning_effort', lowest: 'low' } as const;
const TWO_DECLARED: FakeBackendOptions['reasoning'] = { [SCRIPTED_MODEL]: REASONING, [OTHER]: REASONING };

type Saved = { readonly own?: Readonly<Record<string, string>>; readonly every?: string };

const entryOf = (id: string, effort: string | undefined) => ({ id, capabilities: { contextWindow: 8192, maxOutputTokens: 1024, reasoning: REASONING }, ...(effort === undefined ? {} : { effort }) });

const settingsWith = (place: Place, saved: Saved): void =>
  writeSettings(place.userFile, {
    models: {
      connections: [{ adapter: 'chat-completions', provider: 'scripted', baseUrl: 'http://127.0.0.1:9/v1', models: [entryOf('scripted-model', saved.own?.[SCRIPTED_MODEL]), entryOf('other-model', saved.own?.[OTHER])] }],
      ...(saved.every === undefined ? {} : { effort: saved.every }),
    },
  });

const savedEffortOf = (place: Place, model: string): unknown => {
  const document = stored(place.userFile) as { models: { connections: { models: { id: string; effort?: string }[] }[] } };
  return document.models.connections[0]?.models.find((entry) => `scripted/${entry.id}` === model)?.effort;
};

const started = async (options: FakeBackendOptions, place: Place = freshPlace()): Promise<TerminalApp> => startOnTerminal(SIZE, { settingsPlace: { home: place.home, projectDir: place.project }, ...options });

const opened = async (options: FakeBackendOptions, place?: Place): Promise<TerminalApp> => {
  const app = await started(options, place);
  await app.type('go', shows('go'), 'the prompt is typed');
  await app.type(KEYS.enter, () => true, 'the prompt is sent');
  await app.backend.called('openSession');
  return app;
};

describe('the start figure names the effort that is sent', () => {
  it('shows the clamped effort under the model and says once what was chosen and what is used', async () => {
    const app = await opened({ reasoning: DECLARED, session: { effort: 'minimal' } });
    const screen = await app.type('', shows('effort: low'), 'the effort line is drawn');
    expect(screen.join('\n')).toContain('effort minimal was chosen; scripted-model does not accept it, so low is used');
    app.close();
  });

  it('shows the standard level that is sent, and no note, when the model has a reasoning control and none is chosen', async () => {
    const app = await opened({ reasoning: DECLARED });
    const screen = await app.type('', shows('effort: medium'), 'the standard effort is drawn');
    expect(screen.join('\n')).not.toContain('default');
    expect(screen.join('\n')).not.toContain('was chosen');
    app.close();
  });

  it('says that effort is not available when the model declares no reasoning control', async () => {
    const app = await opened({});
    await app.type('', (lines) => lines.some((line) => line.includes('│') && line.includes('effort: not available for this model')), 'the unavailable effort is drawn');
    app.close();
  });

  it('says effort is not available and that the chosen one is not sent, when the model has no reasoning control', async () => {
    const app = await opened({ session: { effort: 'high' } });
    const screen = await app.type('', shows('none is sent'), 'the note is written');
    expect(screen.join('\n')).toContain('effort: not available for this model');
    app.close();
  });

  it('keeps the effort line in the start screen at 40 columns', async () => {
    const place = freshPlace();
    const app = await startOnTerminal({ columns: 40, rows: 30 }, { settingsPlace: { home: place.home, projectDir: place.project }, reasoning: DECLARED });
    await app.type('go', shows('go'), 'the prompt is typed');
    await app.type(KEYS.enter, () => true, 'the prompt is sent');
    await app.backend.called('openSession');
    await app.type('', shows('effort: medium'), 'the standard effort is drawn at 40 columns');
    app.close();
  });
});

describe('the effort line while the model is still measured', () => {
  it('shows no effort line and no note until the capabilities are known, then the sent level and the note once', async () => {
    const pending = Promise.withResolvers<void>();
    const app = await opened({ reasoning: DECLARED, session: { effort: 'minimal' }, listedProbing: true, modelPending: pending.promise });
    const before = app.screen().join('\n');
    expect(before).not.toContain('effort: ');
    expect(before).not.toContain('was chosen');
    pending.resolve();
    const after = await app.type('', shows('effort: low'), 'the line appears when the model is known');
    expect(after.filter((line) => line.includes('effort minimal was chosen'))).toHaveLength(1);
    app.close();
  });
});

describe('/effort', () => {
  it('sets an accepted level from its argument, saves it for the model and rewrites the effort line of the start figure', async () => {
    const place = freshPlace();
    settingsWith(place, {});
    const app = await opened({ reasoning: DECLARED }, place);
    await app.type(`/effort high${KEYS.enter}`, shows('effort: high for scripted-model; saved'), 'the level is set and saved');
    expect(app.backend.calls).toContain('effort:high');
    expect(savedEffortOf(place, SCRIPTED_MODEL)).toBe('high');
    await app.type('', (lines) => lines.some((line) => line.includes('│') && line.includes('effort: high')), 'the figure follows');
    app.close();
  });

  it('applies a level to this session only with --session, and saves nothing', async () => {
    const place = freshPlace();
    settingsWith(place, {});
    const app = await opened({ reasoning: DECLARED }, place);
    await app.type(`/effort xhigh --session${KEYS.enter}`, shows('effort: xhigh for scripted-model; this session only'), 'the level is set for the session');
    expect(app.backend.calls).toContain('effort:xhigh');
    expect(savedEffortOf(place, SCRIPTED_MODEL)).toBeUndefined();
    app.close();
  });

  it('removes the saved level of the model with reset and drops the session level, so models.effort decides again', async () => {
    const place = freshPlace();
    settingsWith(place, { own: { [SCRIPTED_MODEL]: 'xhigh' }, every: 'low' });
    const app = await opened({ reasoning: DECLARED, session: { effort: 'high' } }, place);
    await app.type(`/effort reset${KEYS.enter}`, shows('effort: low for scripted-model; the level saved for it is removed'), 'the saved level is removed');
    expect(app.backend.calls).toContain('effort:none chosen');
    expect(savedEffortOf(place, SCRIPTED_MODEL)).toBeUndefined();
    app.close();
  });

  it('runs a new session at the level saved for its model, over models.effort', async () => {
    const place = freshPlace();
    settingsWith(place, { own: { [SCRIPTED_MODEL]: 'xhigh' }, every: 'low' });
    const app = await opened({ reasoning: DECLARED }, place);
    await app.type('', (lines) => lines.some((line) => line.includes('│') && line.includes('effort: xhigh')), 'the saved level is drawn');
    app.close();
  });

  it('answers an unaccepted level with the levels the model accepts', async () => {
    const app = await opened({ reasoning: DECLARED });
    await app.type(`/effort minimal${KEYS.enter}`, shows('unknown effort minimal for scripted-model; available: low, medium, high, xhigh'), 'the levels are listed');
    expect(app.backend.calls).not.toContain('effort:minimal');
    app.close();
  });

  it('opens a picker of the accepted levels on the level in force, marked, and Enter sets and saves the chosen one', async () => {
    const place = freshPlace();
    settingsWith(place, {});
    const app = await opened({ reasoning: DECLARED }, place);
    const picker = await app.type(`/effort${KEYS.enter}`, shows('tab: this session only'), 'the picker opens with its hint');
    expect(picker.join('\n')).toContain('xhigh');
    expect(picker.join('\n')).not.toContain('minimal');
    expect(picker.some((line) => line.includes('medium') && line.includes('in use'))).toBe(true);
    await app.type(`${KEYS.down}${KEYS.enter}`, shows('effort: high for scripted-model; saved'), 'the chosen level is set and saved');
    expect(savedEffortOf(place, SCRIPTED_MODEL)).toBe('high');
    app.close();
  });

  it('applies the chosen level of the picker to this session only with the second key', async () => {
    const place = freshPlace();
    settingsWith(place, {});
    const app = await opened({ reasoning: DECLARED }, place);
    await app.type(`/effort${KEYS.enter}`, shows('Reasoning effort'), 'the picker opens');
    await app.type(`${KEYS.down}${KEYS.tab}`, shows('effort: high for scripted-model; this session only'), 'the level is set for the session');
    expect(savedEffortOf(place, SCRIPTED_MODEL)).toBeUndefined();
    app.close();
  });

  it('says that effort is not available for a model without a reasoning control', async () => {
    const app = await opened({});
    await app.type(`/effort high${KEYS.enter}`, shows('effort is not available for scripted-model: it declares no reasoning control'), 'the refusal is shown');
    app.close();
  });
});

describe('/model and the effort', () => {
  it('names the effort the new model runs at when the model changes: its saved level, not the level chosen for the previous model', async () => {
    const place = freshPlace();
    settingsWith(place, { own: { [OTHER]: 'low' } });
    const app = await opened({ reasoning: TWO_DECLARED, models: [SCRIPTED_MODEL, OTHER], session: { effort: 'xhigh' } }, place);
    await app.type(`/model other-model${KEYS.enter}`, shows('model: other-model · effort: low;'), 'the switch names the effort');
    expect(app.backend.calls).toContain(`model:${OTHER}`);
    app.close();
  });

  it('switches and saves a level typed after the model name', async () => {
    const place = freshPlace();
    settingsWith(place, {});
    const app = await opened({ reasoning: TWO_DECLARED, models: [SCRIPTED_MODEL, OTHER] }, place);
    await app.type(`/model other-model high${KEYS.enter}`, shows('effort: high for other-model; saved'), 'the level is saved');
    expect(app.backend.calls).toContain(`model:${OTHER} effort:high`);
    expect(savedEffortOf(place, OTHER)).toBe('high');
    app.close();
  });

  it('shows in the picker the effort each model would run at, changes the chosen row with the arrows, and saves a changed level on Enter', async () => {
    const place = freshPlace();
    settingsWith(place, { own: { [OTHER]: 'low' } });
    const app = await opened({ reasoning: TWO_DECLARED, models: [SCRIPTED_MODEL, OTHER], session: { effort: 'high' } }, place);
    const picker = await app.type(`/model${KEYS.enter}`, shows('change the effort'), 'the picker opens with its hint');
    expect(picker.some((line) => line.includes('scripted-model') && line.includes('effort: ‹ high ›'))).toBe(true);
    expect(picker.some((line) => line.includes('other-model') && line.includes('effort: low'))).toBe(true);
    expect(picker.join('\n')).toContain('left/right: change the effort');
    await app.type(KEYS.down, (lines) => lines.some((line) => line.includes('other-model') && line.includes('effort: ‹ low ›')), 'the other row is chosen');
    await app.type(`${KEYS.right}${KEYS.right}`, (lines) => lines.some((line) => line.includes('other-model') && line.includes('effort: ‹ high ›')), 'the level is raised');
    await app.type(KEYS.enter, shows('effort: high for other-model; saved'), 'the switch saves the level');
    expect(app.backend.calls).toContain(`model:${OTHER} effort:high`);
    expect(savedEffortOf(place, OTHER)).toBe('high');
    app.close();
  });

  it('writes nothing when the level of the chosen row is not changed', async () => {
    const place = freshPlace();
    settingsWith(place, { own: { [OTHER]: 'low' } });
    const app = await opened({ reasoning: TWO_DECLARED, models: [SCRIPTED_MODEL, OTHER] }, place);
    await app.type(`/model${KEYS.enter}`, shows('Models'), 'the picker opens');
    await app.type(`${KEYS.down}${KEYS.enter}`, shows('model: other-model · effort: low'), 'the switch is made');
    expect(app.backend.calls).toContain(`model:${OTHER}`);
    expect(savedEffortOf(place, OTHER)).toBe('low');
    app.close();
  });
});

describe('the footer names the model and its effort', () => {
  it('shows the level in force beside the model, and follows /effort', async () => {
    const place = freshPlace();
    settingsWith(place, {});
    const app = await opened({ reasoning: DECLARED }, place);
    await app.type('', shows('context: 0% · scripted-model · effort: medium'), 'the footer names the effort');
    await app.type(`/effort high --session${KEYS.enter}`, shows('scripted-model · effort: high'), 'the footer follows');
    app.close();
  });

  it('follows a level written by a settings flow, not only by /effort', async () => {
    const place = freshPlace();
    settingsWith(place, {});
    const app = await opened({ reasoning: DECLARED }, place);
    await app.type('', shows('scripted-model · effort: medium'), 'the standard level is in the footer');
    settingsWith(place, { own: { [SCRIPTED_MODEL]: 'xhigh' } });
    await app.type(`/model${KEYS.enter}`, shows(MODEL_SETTINGS_ROW), 'the model list opens');
    await app.type(`${KEYS.up}${KEYS.enter}`, shows('Check the servers'), 'the models screen opens from its last row');
    await app.type(KEYS.ctrlC, shows(MODEL_SETTINGS_ROW), 'leaving the models screen comes back to the model list');
    await app.type(KEYS.ctrlC, shows('scripted-model · effort: xhigh'), 'the footer follows the written level');
    app.close();
  });
});
