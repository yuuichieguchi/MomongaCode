import { describe, expect, it, vi } from 'vitest';
import { SCRIPTED_MODEL } from '@momonga/testkit';
import { CONTEXT_IMPROVE_TOKEN_NOTICE } from '../../src/commands/context.ts';
import { CONTEXT_IMPROVE_CONFIRM_TITLE } from '../../src/tui/commands/context.ts';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { freshPlace } from './settings-harness.tsx';
import { startOnTerminal } from './terminal-app.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const SIZE = { columns: 110, rows: 30 };

describe('/context improve confirmation in the terminal UI', () => {
  it('shows model, bundled dataset, candidate count, outcome and token-spending notice before starting, defaults to Cancel, and runs with --yes on Start', async () => {
    const place = freshPlace();
    const ran: (readonly string[])[] = [];
    const app = await startOnTerminal(
      SIZE,
      { settingsPlace: { home: place.home, projectDir: place.project } },
      {
        shell: {
          run: async (argv, io) => {
            ran.push(argv);
            io.write('context improve started\n');
            return 0;
          },
        },
      },
    );

    await app.type(
      `/context improve${KEYS.enter}`,
      (lines) =>
        lines.some((line) => line.includes(CONTEXT_IMPROVE_CONFIRM_TITLE)) &&
        lines.some((line) => line.includes('Dataset: bundled context-starter')) &&
        lines.some((line) => line.includes('Candidates: 1')) &&
        lines.some((line) => line.includes(CONTEXT_IMPROVE_TOKEN_NOTICE)) &&
        lines.some((line) => line.includes('› 2. Cancel')),
      'confirmation panel shows plan, token-spending notice, and defaults to Cancel',
    );

    await app.type(
      KEYS.enter,
      (lines) => lines.some((line) => line.includes('context improve cancelled')) && !lines.some((line) => line.includes(CONTEXT_IMPROVE_CONFIRM_TITLE)),
      'Enter on default Cancel aborts without running',
    );
    expect(ran).toEqual([]);

    await app.type(
      `/context improve --candidates 2${KEYS.enter}`,
      (lines) => lines.some((line) => line.includes(CONTEXT_IMPROVE_CONFIRM_TITLE)) && lines.some((line) => line.includes('Candidates: 2')),
      'confirmation panel reflects explicit --candidates',
    );
    await app.type(KEYS.up, (lines) => lines.some((line) => line.includes('› 1. Start')), 'Up moves highlight to Start');
    await app.type(
      KEYS.enter,
      (lines) => lines.some((line) => line.includes('context improve started')) && !lines.some((line) => line.includes(CONTEXT_IMPROVE_CONFIRM_TITLE)),
      'Enter on Start launches context improve',
    );
    expect(ran).toEqual([['context', 'improve', '--candidates', '2', '--model', SCRIPTED_MODEL, '--yes']]);

    await app.type(`/context improve --yes${KEYS.enter}`, (lines) => ran.length === 2 && lines.some((line) => line.includes('context improve started')), '--yes runs directly without opening confirmation panel');
    expect(ran[1]).toEqual(['context', 'improve', '--yes', '--model', SCRIPTED_MODEL]);

    app.close();
  });
});
