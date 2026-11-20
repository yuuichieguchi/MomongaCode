import { describe, expect, it, vi } from 'vitest';
import type { ReasoningEffort } from '@momonga/protocol';
import { SCRIPTED_MODEL } from '@momonga/testkit';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { frame } from '../tui-harness.tsx';
import { freshPlace } from './settings-harness.tsx';
import { startOnTerminal } from './terminal-app.tsx';
import type { TerminalApp } from './terminal-app.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const OTHER = 'ollama/qwen3.8:27b';
const BACKUP = 'ollama/gemma9:12b';
const ESC = '\u001b';
const click = (col: number, row: number): string => `${ESC}[<0;${col};${row}M${ESC}[<0;${col};${row}m`;
const rowOf = (lines: string[], text: string): number => lines.findIndex((line) => line.includes(text));
const isHeader = (line: string): boolean => line.startsWith('Subagent ') || line.startsWith('running · ') || line.includes('… · running');
const headerOf = (lines: string[]): string => (lines.find(isHeader) ?? '').trimEnd();

const THINK = 'ollama-127.0.0.1-18477/think-c:latest';
const PLAIN = 'ollama-127.0.0.1-18477/plain-b:latest';
const REASONING = { [OTHER]: { control: 'reasoning_effort', lowest: 'low' }, [THINK]: { control: 'reasoning_effort', lowest: 'none' } } as const;

const openChild = async (size: { columns: number; rows: number }, childModel: string, childEffort?: ReasoningEffort): Promise<TerminalApp> => {
  const place = freshPlace();
  const app = await startOnTerminal(size, { settingsPlace: { home: place.home, projectDir: place.project }, models: [SCRIPTED_MODEL, OTHER, BACKUP, THINK, PLAIN], reasoning: REASONING });
  await app.type('go', (lines) => lines.some((line) => line.includes('go')), 'the prompt is typed');
  await app.type(KEYS.enter, () => true, 'the prompt is sent');
  await app.backend.called('openSession');
  app.backend.following().onChildStarted('general-purpose', 'child-1', 0, childModel, childEffort);
  const row = rowOf(await app.type('', (lines) => rowOf(lines, 'general-purpose · starting') >= 0, 'the child is listed'), 'general-purpose · starting');
  await app.type(click(3, row + 1), (lines) => lines.some(isHeader), 'the view is opened');
  return app;
};

describe('the header of a subagent view names the model the child run runs on', () => {
  it('shows the model of the child run when it differs from the main one, with the standard effort it sends when none is chosen', async () => {
    const app = await openChild({ columns: 100, rows: 30 }, OTHER);
    expect(headerOf(app.screen())).toBe('Subagent general-purpose · running · model: ollama/qwen3.8:27b (effort: medium)');
    app.close();
  });

  it('shows the main model when the child runs on the model of its parent', async () => {
    const app = await openChild({ columns: 100, rows: 30 }, SCRIPTED_MODEL);
    const header = headerOf(app.screen());
    expect(header.startsWith('Subagent general-purpose · running · model: ')).toBe(true);
    expect(header).not.toContain('qwen3.8');
    app.close();
  });

  it('follows the model that answers when the child falls back to another one', async () => {
    const app = await openChild({ columns: 100, rows: 30 }, OTHER);
    app.backend.following().onChildEvent(frame({ runId: 'child-1', type: 'model.responded', attempt: 0, target: BACKUP, response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }), 'general-purpose');
    const shown = await app.type('', (lines) => headerOf(lines).includes('gemma9'), 'the header follows the fallback');
    expect(headerOf(shown)).toBe('Subagent general-purpose · running · model: ollama/gemma9:12b (effort: medium)');
    app.close();
  });

  it('keeps the state, the model and the standard effort at 40 columns', async () => {
    const app = await openChild({ columns: 40, rows: 30 }, OTHER);
    expect(headerOf(app.screen())).toBe('running · ollama/qwen3.8:27b (medium)');
    app.close();
  });

  it('names the effort the child really sends, clamped to its model, and says not available when its model declares no effort', async () => {
    const clamped = await openChild({ columns: 100, rows: 30 }, OTHER, 'minimal');
    expect(headerOf(clamped.screen())).toBe('Subagent general-purpose · running · model: ollama/qwen3.8:27b (effort: low)');
    clamped.close();
    const unsent = await openChild({ columns: 100, rows: 30 }, SCRIPTED_MODEL, 'high');
    expect(headerOf(unsent.screen())).toBe('Subagent general-purpose · running · model: scripted-model (effort: not available)');
    unsent.close();
  });

  it('keeps the state, the model and the chosen effort at 40 columns', async () => {
    const app = await openChild({ columns: 40, rows: 30 }, OTHER, 'high');
    expect(headerOf(app.screen())).toBe('running · ollama/qwen3.8:27b (high)');
    app.close();
  });

  it('keeps the state, the model and the unavailable effort at 40 columns', async () => {
    const app = await openChild({ columns: 40, rows: 30 }, SCRIPTED_MODEL);
    expect(headerOf(app.screen())).toBe('running · scripted-model (not available)');
    app.close();
  });

  const SERVER_HEADERS: Readonly<Record<number, readonly string[]>> = {
    120: ['Subagent general-purpose · running · model: ollama-127.0.0.1-18477/think-c (effort: medium)', 'Subagent general-purpose · running · model: ollama-127.0.0.1-18477/plain-b (effort: not available)'],
    80: ['general-purp… · running · model: ollama-127.0.0.1-18477/think-c (effort: medium)', 'gener… · running · model: ollama-127.0.0.1-18477/plain-b (effort: not available)'],
    60: ['running · ollama-127.0.0.1-18477/think-c (medium)', 'running · ollama-127.0.0.1-18477/plain-b (not available)'],
    40: ['running · ollama-127.0.0.1-18477/think-…', 'running · ollama-127.0.0.1-18477/plain-…'],
  };

  for (const columns of [120, 80, 60, 40]) {
    it(`names a server model with its effort at ${columns} columns`, async () => {
      const think = await openChild({ columns, rows: 30 }, THINK);
      const plain = await openChild({ columns, rows: 30 }, PLAIN);
      expect([headerOf(think.screen()), headerOf(plain.screen())]).toEqual(SERVER_HEADERS[columns]);
      think.close();
      plain.close();
    });
  }
});
