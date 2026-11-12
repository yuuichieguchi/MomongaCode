import { describe, expect, it } from 'vitest';
import { createTerminalScreen } from '@momonga/testkit/terminal-screen';

describe('the terminal screen of the tests', () => {
  it('shows what a partial redraw leaves on the screen, not the bytes that were sent', async () => {
    const screen = createTerminalScreen({ columns: 20, rows: 3 });
    await screen.write('first line\r\nsecond line');
    await screen.write('\u001b[1;1H\u001b[2Kredrawn');
    expect(screen.text()).toEqual(['redrawn', 'second line', '']);
    expect(screen.lineAt(1)).toBe('second line');
    expect(screen.cursor()).toEqual({ row: 0, column: 7 });
    screen.dispose();
  });

  it('answers a device attributes query as a terminal does', async () => {
    const screen = createTerminalScreen({ columns: 20, rows: 3 });
    const answers: string[] = [];
    screen.onAnswer((answer) => answers.push(answer));
    await screen.write('\u001b[c');
    expect(answers.join('')).toMatch(/^\u001b\[\?[\d;]+c$/);
    screen.dispose();
  });

  it('refuses a row outside the screen', () => {
    const screen = createTerminalScreen({ columns: 20, rows: 3 });
    expect(() => screen.lineAt(3)).toThrow('the terminal screen has no row 3; it has 3');
    screen.dispose();
  });
});
