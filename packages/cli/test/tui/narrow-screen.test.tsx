import { describe, expect, it } from 'vitest';
import { startPlan } from '../fake-plan-gateway.tsx';
import { untilFrame } from '../ink-helpers.ts';
import { start } from '../tui-harness.tsx';

const NARROW = { columns: 40, rows: 24 };

const linesOf = (text: string): string[] => text.split('\n');

describe('the screens at 40 columns (real-use-33)', () => {
  it('drops footer segments whole and keeps the start screen inside the width', async () => {
    const { app } = await start({}, { startup: { version: '1.2.3', home: '/home/someone' } }, NARROW);
    const shown = linesOf(await untilFrame(app, 'mode: manual'));
    expect(shown.at(-1)).toBe('mode: manual (shift+tab) · tokens: 0');
    expect(shown.every((line) => [...line].length <= NARROW.columns)).toBe(true);
    app.unmount();
  });

  it('wraps the invitation to the rows it needs, so the command it names is not cut', async () => {
    const { app } = await startPlan({ accounts: [] }, { startup: { version: '1.2.3', home: '/home/none' } }, NARROW);
    const shown = await untilFrame(app, 'Use your ChatGPT plan');
    const words = linesOf(shown)
      .filter((line) => !line.startsWith('╭') && !line.startsWith('│') && !line.startsWith('╰') && !line.startsWith('mode:'))
      .join(' ')
      .split(/\s+/);
    expect(words).toContain('/login');
    expect(shown).not.toContain('…');
    expect(linesOf(shown).every((line) => [...line].length <= NARROW.columns)).toBe(true);
    app.unmount();
  });
});
