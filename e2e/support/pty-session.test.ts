import { PassThrough } from 'node:stream';
import { createTerminalScreen } from '@momonga/testkit/terminal-screen';
import { afterEach, describe, expect, it } from 'vitest';
import { attachPtySession } from './pty.ts';
import type { PtyExit, PtySession } from './pty.ts';

const COLUMNS = 40;
const ROWS = 8;
const HOME_AND_CLEAR = '\u001b[H\u001b[2J';

const box = (content: string): string[] => [`╭${'─'.repeat(COLUMNS - 2)}╮`, `│ ${content.padEnd(COLUMNS - 4)} │`, `╰${'─'.repeat(COLUMNS - 2)}╯`];

const frameOf = (transcript: readonly string[], input: string, footer: string): string => {
  const rows = [...transcript, ...box(input), footer];
  return HOME_AND_CLEAR + rows.join('\r\n');
};

type Harness = { session: PtySession; draw(text: string): void; typed(): string; close(status: PtyExit): void };

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

const harness = (): Harness => {
  const input = new PassThrough();
  const output = new PassThrough();
  let typed = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    typed += chunk;
  });
  let close: (status: PtyExit) => void = () => undefined;
  const closed = new Promise<PtyExit>((resolve) => {
    close = resolve;
  });
  const terminal = createTerminalScreen({ columns: COLUMNS, rows: ROWS });
  disposals.push(() => terminal.dispose());
  const session = attachPtySession({ input, output, closed, terminal });
  return { session, draw: (text) => output.write(text), typed: () => typed, close };
};

const BOUND_MS = 2000;

describe('the pty session of the e2e tests', () => {
  it('refuses a wait whose condition already held on the screen before the last key, naming the pattern and the row', async () => {
    const { session, draw } = harness();
    draw(frameOf(['hello there'], '> ', 'mode: manual (shift+tab)'));
    await session.waitFor('mode: manual', { boundMs: BOUND_MS });
    await expect(session.key('shiftTab', { until: 'mode: manual', boundMs: BOUND_MS })).rejects.toThrow(/mode: manual[\s\S]*already true before the write; it proves nothing[\s\S]*mode: manual \(shift\+tab\)/);
  });

  it('resolves a key once its proving condition appears and returns the frame that proved it', async () => {
    const { session, draw, typed } = harness();
    draw(frameOf([], '> ', 'mode: manual (shift+tab)'));
    await session.waitFor('mode: manual', { boundMs: BOUND_MS });
    const proved = session.key('shiftTab', { until: 'mode: plan', boundMs: BOUND_MS });
    setTimeout(() => draw(frameOf([], '> ', 'mode: plan (shift+tab)')), 50);
    const frame = await proved;
    expect(typed()).toBe('\u001b[Z');
    expect(frame.region('footer')).toEqual(['mode: plan (shift+tab)']);
  });

  it('matches a region wait against that region only, so text in the transcript does not satisfy a wait for the input box', async () => {
    const { session, draw } = harness();
    draw(frameOf(['> line two'], '> ', 'mode: manual (shift+tab)'));
    await session.waitFor('mode: manual', { boundMs: BOUND_MS });
    const echoed = session.type('line two', { boundMs: BOUND_MS });
    let settled = false;
    void echoed.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    draw(frameOf(['> line two'], '> line two', 'mode: manual (shift+tab)'));
    const frame = await echoed;
    expect(frame.region('input')).toEqual(['> line two']);
    expect(frame.region('transcript')).toContain('> line two');
    expect(frame.region('footer')).toEqual(['mode: manual (shift+tab)']);
  });

  it('refuses a state-changing key or control text sent without the state it must produce', async () => {
    const { session, draw, typed } = harness();
    draw(frameOf([], '> ', 'mode: manual (shift+tab)'));
    await session.waitFor('mode: manual', { boundMs: BOUND_MS });
    expect(() => session.write('\r')).toThrow(/state-changing key/);
    expect(() => session.write('value\r')).toThrow(/state-changing key/);
    expect(() => session.write('\u001b[A')).toThrow(/state-changing key/);
    await expect(session.type('\u0003', { boundMs: BOUND_MS })).rejects.toThrow(/state-changing key/);
    await expect(Reflect.apply(session.key, session, ['enter', {}])).rejects.toThrow(/without the state it must produce/);
    expect(typed()).toBe('');
  });

  it('waits for a pattern to disappear, and refuses that wait when the pattern was already absent before the key', async () => {
    const { session, draw } = harness();
    draw(frameOf(['The sandbox is off', '› 2. Cancel'], '> ', 'mode: manual (shift+tab)'));
    await session.waitFor('The sandbox is off', { boundMs: BOUND_MS });
    const gone = session.key('escape', { until: { lacks: 'The sandbox is off' }, boundMs: BOUND_MS });
    setTimeout(() => draw(frameOf([], '> ', 'mode: manual (shift+tab)')), 50);
    const frame = await gone;
    expect(frame.rows.join('\n')).not.toContain('The sandbox is off');
    await expect(session.waitForGone('never drawn', { boundMs: BOUND_MS })).rejects.toThrow(/never drawn[\s\S]*already true before the write; it proves nothing/);
  });

  it('waits for a prompt only once its settled hint row is drawn, never on a fixed pause', async () => {
    const { session, draw } = harness();
    draw(frameOf(['Pick one', '› 1. Yes', ' '], '> ', 'mode: manual (shift+tab)'));
    const prompt = session.waitForPrompt('Pick one', { boundMs: BOUND_MS });
    let settled = false;
    void prompt.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(settled).toBe(false);
    draw(frameOf(['Pick one', '› 1. Yes', 'enter to choose'], '> ', 'mode: manual (shift+tab)'));
    expect((await prompt).rows).toContain('enter to choose');
  });

  it('ends a key whose proof is the exit of the command with the exit status and the last frame', async () => {
    const { session, draw, close } = harness();
    draw(frameOf([], '> ', 'mode: manual (shift+tab)'));
    await session.waitFor('mode: manual', { boundMs: BOUND_MS });
    const exited = session.key('ctrlD', { until: 'exit', boundMs: BOUND_MS });
    setTimeout(() => close({ code: 0, signal: null }), 50);
    const { status, frame } = await exited;
    expect(status).toEqual({ code: 0, signal: null });
    expect(frame.region('footer')).toEqual(['mode: manual (shift+tab)']);
  });
});
