import { describe, expect, it, vi } from 'vitest';
import { defaultTuiSettings } from '@momonga/config';
import { DEFAULT_SLASH_COMMANDS } from '../../src/tui/commands/index.ts';
import { slashMenuEntries } from '../../src/tui/screen/menu.tsx';
import { KEYS, TUI_TEST_TIMEOUT_MS } from '../ink-helpers.ts';
import { freshPlace } from './settings-harness.tsx';
import { startOnTerminal } from './terminal-app.tsx';

vi.setConfig({ testTimeout: TUI_TEST_TIMEOUT_MS });

const SIZE = { columns: 100, rows: 30 };

describe('slashMenuEntries after a space', () => {
  it('offers first-level subcommands after a trailing space and filters by prefix', () => {
    const all = slashMenuEntries('/context ', DEFAULT_SLASH_COMMANDS);
    expect(all?.map((entry) => entry.key)).toEqual(['/context improve', '/context guideline']);
    expect(all?.[0]).toMatchObject({ completeText: '/context improve ', runText: '/context improve', continueOnEnter: false });
    expect(all?.[1]).toMatchObject({ completeText: '/context guideline ', runText: '/context guideline', continueOnEnter: true });

    const filtered = slashMenuEntries('/context gui', DEFAULT_SLASH_COMMANDS);
    expect(filtered?.map((entry) => entry.key)).toEqual(['/context guideline']);
  });

  it('offers second-level subcommands in declared order after a parent subcommand and trailing space', () => {
    expect(slashMenuEntries('/context guideline ', DEFAULT_SLASH_COMMANDS)?.map((entry) => entry.key)).toEqual([
      '/context guideline adopt',
      '/context guideline list',
      '/context guideline rollback',
    ]);
    expect(slashMenuEntries('/mode ', DEFAULT_SLASH_COMMANDS)?.map((entry) => entry.key)).toEqual([
      '/mode manual',
      '/mode acceptEdits',
      '/mode plan',
      '/mode auto',
      '/mode bypassPermissions',
    ]);
    expect(slashMenuEntries('/effort ', DEFAULT_SLASH_COMMANDS)?.map((entry) => entry.key)).toEqual([
      '/effort none',
      '/effort minimal',
      '/effort low',
      '/effort medium',
      '/effort high',
      '/effort xhigh',
      '/effort max',
      '/effort reset',
    ]);
    expect(slashMenuEntries('/context guideline l', DEFAULT_SLASH_COMMANDS)?.map((entry) => entry.key)).toEqual(['/context guideline list', '/context guideline rollback']);
    expect(slashMenuEntries('/context guideline li', DEFAULT_SLASH_COMMANDS)?.map((entry) => entry.key)).toEqual(['/context guideline list']);
    expect(slashMenuEntries('/tui mouse ', DEFAULT_SLASH_COMMANDS)?.map((entry) => entry.key)).toEqual(['/tui mouse on', '/tui mouse off']);
    expect(slashMenuEntries('/config notify ', DEFAULT_SLASH_COMMANDS)?.map((entry) => entry.key)).toEqual(['/config notify off', '/config notify bell']);
    expect(slashMenuEntries('/config notify', DEFAULT_SLASH_COMMANDS)?.[0]).toMatchObject({ key: '/config notify', continueOnEnter: false });
    expect(slashMenuEntries('/memory review', DEFAULT_SLASH_COMMANDS)?.[0]).toMatchObject({ key: '/memory review', continueOnEnter: false });
  });

  it('closes the menu once past leaf subcommands, for flags, for unknown subcommands, or for commands without subcommands', () => {
    expect(slashMenuEntries('/context improve ', DEFAULT_SLASH_COMMANDS)).toBeUndefined();
    expect(slashMenuEntries('/context improve --dataset foo', DEFAULT_SLASH_COMMANDS)).toBeUndefined();
    expect(slashMenuEntries('/context guideline list ', DEFAULT_SLASH_COMMANDS)).toBeUndefined();
    expect(slashMenuEntries('/network --json', DEFAULT_SLASH_COMMANDS)).toBeUndefined();
    expect(slashMenuEntries('/tui -', DEFAULT_SLASH_COMMANDS)).toBeUndefined();
    expect(slashMenuEntries('/config -', DEFAULT_SLASH_COMMANDS)).toBeUndefined();
    expect(slashMenuEntries('/context unknown', DEFAULT_SLASH_COMMANDS)).toBeUndefined();
    expect(slashMenuEntries('/compact focus on tests', DEFAULT_SLASH_COMMANDS)).toBeUndefined();
    expect(slashMenuEntries('/context \n', DEFAULT_SLASH_COMMANDS)).toBeUndefined();
  });

  it('covers fixed subcommands and choices across every built-in and shell command that defines them', () => {
    for (const [prefix, expected] of [
      ['/auth ', '/auth status'],
      ['/mcp ', '/mcp list'],
      ['/policy ', '/policy verify'],
      ['/gateway ', '/gateway probe'],
      ['/auto-mode ', '/auto-mode check'],
      ['/memory ', '/memory list'],
      ['/rule ', '/rule list'],
      ['/network ', '/network check'],
      ['/markers ', '/markers ignore'],
      ['/mode ', '/mode plan'],
      ['/effort ', '/effort reset'],
      ['/theme ', '/theme dark'],
      ['/tui ', '/tui mouse'],
      ['/config ', '/config notify'],
    ] as const) {
      expect(slashMenuEntries(prefix, DEFAULT_SLASH_COMMANDS)?.map((entry) => entry.key)).toContain(expected);
    }
  });
});

describe('staged slash subcommand completion in the terminal UI', () => {
  it('keeps predictions open after Tab or space on /context, drills into guideline on Enter, and runs the leaf subcommand on Enter', async () => {
    const place = freshPlace();
    const ran: (readonly string[])[] = [];
    const app = await startOnTerminal(
      SIZE,
      { settingsPlace: { home: place.home, projectDir: place.project } },
      {
        shell: {
          run: async (argv, io) => {
            ran.push(argv);
            io.write('no guidelines stored yet\n');
            return 0;
          },
        },
      },
    );
    await app.type('/context', (lines) => lines.some((line) => line.includes('› /context ')), 'top-level /context menu is shown');
    await app.type(KEYS.tab, (lines) => lines.some((line) => line.includes('/context improve')) && lines.some((line) => line.includes('/context guideline')), 'Tab opens first-level subcommands');
    await app.type(KEYS.down, (lines) => lines.some((line) => line.includes('› /context guideline')), 'down arrow selects guideline');
    await app.type(
      KEYS.enter,
      (lines) => lines.some((line) => line.includes('/context guideline adopt')) && lines.some((line) => line.includes('/context guideline list')),
      'Enter on non-leaf subcommand opens second-level subcommands',
    );
    await app.type(KEYS.down, (lines) => lines.some((line) => line.includes('› /context guideline list')), 'down arrow highlights list');
    await app.type(KEYS.enter, (lines) => lines.some((line) => line.includes('no guidelines stored yet')), 'Enter on leaf subcommand executes /context guideline list');
    expect(ran).toEqual([['context', 'guideline', 'list']]);
    app.close();
  });

  it('completes a leaf choice after a space and runs it on Enter for built-in commands like /tui', async () => {
    const place = freshPlace();
    const saved: Array<[string, unknown]> = [];
    const app = await startOnTerminal(
      SIZE,
      { settingsPlace: { home: place.home, projectDir: place.project } },
      {
        tuiSettings: {
          initial: defaultTuiSettings(),
          save: async (name, value) => {
            saved.push([name, value]);
          },
        },
      },
    );
    await app.type('/tui mouse ', (lines) => lines.some((line) => line.includes('› /tui mouse on')) && lines.some((line) => line.includes('/tui mouse off')), 'second-level switch choices appear after space');
    await app.type(KEYS.down, (lines) => lines.some((line) => line.includes('› /tui mouse off')), 'down arrow highlights off');
    await app.type(KEYS.enter, (lines) => lines.some((line) => line.includes('Mouse: off')), 'Enter executes /tui mouse off');
    expect(saved).toEqual([['mouse', false]]);
    await app.type('/config notify', (lines) => lines.some((line) => line.includes('› /config notify')), 'standalone parent menu row renders');
    await app.type(KEYS.tab, (lines) => lines.some((line) => line.includes('› /config notify off')) && lines.some((line) => line.includes('/config notify bell')), 'Tab on standalone parent opens child choices');
    await app.type('\u001b[27u', (lines) => !lines.some((line) => line.includes('/config notify bell')) && lines.some((line) => line.includes('> /config notify ')), 'Escape closes subcommand menu and keeps typed text');
    await app.type(KEYS.ctrlC, (lines) => !lines.some((line) => line.includes('> /config notify')), 'Ctrl+C clears draft');
    await app.type('/config notify', (lines) => lines.some((line) => line.includes('› /config notify')), 'standalone parent reopens cleanly');
    await app.type(KEYS.enter, (lines) => lines.some((line) => line.includes('notify: off')), 'Enter on standalone parent /config notify shows current value without mutating');
    expect(saved).toEqual([['mouse', false]]);
    await app.type('/context imp', (lines) => lines.some((line) => line.includes('› /context improve')), 'prefix filters /context improve');
    await app.type(KEYS.tab, (lines) => lines.some((line) => line.includes('> /context improve ')) && !lines.some((line) => line.includes('› /context improve')), 'Tab on leaf subcommand completes with space and closes menu');
    app.close();
  });
});
