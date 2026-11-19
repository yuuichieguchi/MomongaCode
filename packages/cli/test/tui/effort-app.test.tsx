import { describe, expect, it, vi } from 'vitest';
import { SCRIPTED_MODEL } from '@momonga/testkit';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { freshPlace } from './settings-harness.tsx';
import { startOnTerminal } from './terminal-app.tsx';
import type { TerminalApp } from './terminal-app.tsx';
import type { FakeBackendOptions } from '../fake-backend.ts';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const SIZE = { columns: 100, rows: 30 };
const DECLARED: FakeBackendOptions['reasoning'] = { [SCRIPTED_MODEL]: { control: 'reasoning_effort', lowest: 'low' } };
const shows = (text: string) => (lines: string[]): boolean => lines.some((line) => line.includes(text));

const started = async (options: FakeBackendOptions): Promise<TerminalApp> => {
  const place = freshPlace();
  return startOnTerminal(SIZE, { settingsPlace: { home: place.home, projectDir: place.project }, ...options });
};

const opened = async (options: FakeBackendOptions): Promise<TerminalApp> => {
  const app = await started(options);
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

  it('shows no effort line when no effort is chosen', async () => {
    const app = await opened({ reasoning: DECLARED });
    expect(app.screen().join('\n')).not.toContain('effort');
    app.close();
  });

  it('shows no effort line when the model declares no reasoning control, and says the chosen one is not sent', async () => {
    const app = await opened({ session: { effort: 'high' } });
    const screen = await app.type('', shows('none is sent'), 'the note is written');
    expect(screen.some((line) => line.includes('effort: '))).toBe(false);
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
  it('rewrites the effort line of the start figure to the level now chosen', async () => {
    const app = await opened({ reasoning: DECLARED });
    await app.type(`/effort high${KEYS.enter}`, shows('effort: high; applies from the next run'), 'the level is set');
    await app.type('', (lines) => lines.some((line) => line.includes('│') && line.includes('effort: high')), 'the figure follows');
    app.close();
  });

  it('sets an accepted level from its argument, from the next run', async () => {
    const app = await opened({ reasoning: DECLARED });
    await app.type(`/effort high${KEYS.enter}`, shows('effort: high; applies from the next run'), 'the level is set');
    expect(app.backend.calls).toContain('effort:high');
    app.close();
  });

  it('answers an unaccepted level with the levels the model accepts', async () => {
    const app = await opened({ reasoning: DECLARED });
    await app.type(`/effort minimal${KEYS.enter}`, shows('unknown effort minimal for scripted-model; available: low, medium, high, xhigh'), 'the levels are listed');
    expect(app.backend.calls).not.toContain('effort:minimal');
    app.close();
  });

  it('opens a picker of the accepted levels without an argument, and Enter sets the chosen one', async () => {
    const app = await opened({ reasoning: DECLARED });
    const picker = await app.type(`/effort${KEYS.enter}`, shows('Reasoning effort'), 'the picker opens');
    expect(picker.join('\n')).toContain('xhigh');
    expect(picker.join('\n')).not.toContain('minimal');
    await app.type(KEYS.enter, shows('effort: low; applies from the next run'), 'the first level is set');
    app.close();
  });

  it('says that a model without a reasoning control takes no effort', async () => {
    const app = await opened({});
    await app.type(`/effort high${KEYS.enter}`, shows('declares no reasoning effort, so no effort can be sent to it'), 'the refusal is shown');
    app.close();
  });
});
