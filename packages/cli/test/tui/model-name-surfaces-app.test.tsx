import { describe, expect, it, vi } from 'vitest';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { freshPlace } from './settings-harness.tsx';
import { startOnTerminal } from './terminal-app.tsx';
import type { TerminalApp } from './terminal-app.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const LOCAL = 'ollama/qwen3.8:27b';
const PLAN = 'chatgpt/gpt-6-luna';
const REASONING = { [LOCAL]: { control: 'reasoning_effort', lowest: 'low' }, [PLAN]: { control: 'reasoning_effort', lowest: 'low' } } as const;

const holds = (text: string) => (lines: string[]): boolean => lines.some((line) => line.includes(text));
const isHeader = (line: string): boolean => line.startsWith('Subagent ');

const opened = async (): Promise<TerminalApp> => {
  const place = freshPlace();
  return startOnTerminal({ columns: 100, rows: 30 }, { settingsPlace: { home: place.home, projectDir: place.project }, session: { model: LOCAL }, models: [LOCAL, PLAN], reasoning: REASONING });
};

describe('a model is shown by one name on every surface of a session', () => {
  it('the start figure names the local model with its server', async () => {
    const app = await opened();
    const screen = await app.type('', holds(`model: ${LOCAL}`), 'the start figure names the model');
    expect(screen.join('\n')).toContain(`model: ${LOCAL}`);
    app.close();
  });

  it('the /model rows name the local model with its server and the plan model by its own name', async () => {
    const app = await opened();
    const list = await app.type('/model\r', holds('gpt-6-luna'), 'the model list is open');
    expect(list.some((line) => line.includes(LOCAL))).toBe(true);
    expect(list.some((line) => line.includes(PLAN))).toBe(false);
    app.close();
  });

  it('the switch line, the footer and the header of a subagent name each model by its one name', async () => {
    const app = await opened();
    await app.type('/model\r', holds('gpt-6-luna'), 'the model list is open');
    const switched = await app.type('2', holds('model: gpt-6-luna'), 'the switch line is written');
    expect(switched.join('\n')).not.toContain(PLAN);
    await app.type('go', holds('go'), 'the prompt is typed');
    const sent = await app.type(KEYS.enter, (lines) => lines.some((line) => line.includes('tokens:') && line.includes('gpt-6-luna · ')), 'the footer names the model');
    expect(sent.find((line) => line.includes('tokens:'))).not.toContain(PLAN);
    await app.backend.called('openSession');
    app.backend.following().onChildStarted('general-purpose', 'child-1', 0, LOCAL, undefined);
    const listed = await app.type('', holds('general-purpose · starting'), 'the child is listed');
    const row = listed.findIndex((line) => line.includes('general-purpose · starting'));
    const header = await app.type(`\u001b[<0;3;${row + 1}M\u001b[<0;3;${row + 1}m`, (lines) => lines.some(isHeader), 'the view is opened');
    expect(header.find(isHeader)).toContain(`model: ${LOCAL}`);
    app.close();
  });
});
