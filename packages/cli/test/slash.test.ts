import { describe, expect, it } from 'vitest';
import type { MemoryView, SkillView } from '@momonga/protocol';
import { DEFAULT_SLASH_COMMANDS } from '../src/tui/commands/index.ts';
import { skillCommands } from '../src/tui/commands/skills.ts';
import { DEFAULT_KEY_TABLE } from '../src/tui/keys/table.ts';
import { BUILTIN_SLASH_COMMANDS, createSlashRegistry, helpText, newlineHelpLines, parseSlash } from '../src/tui/slash.ts';
import type { SlashContext } from '../src/tui/slash.ts';
import { SESSION, fakeBackend } from './fake-backend.ts';
import type { FakeBackendOptions } from './fake-backend.ts';
import { fixedKeyBindings } from '../src/tui/keys/store.ts';
import { NO_A11Y } from '../src/tui/screen/a11y.ts';
import { createFoundServers } from '../src/tui/models/context.ts';

describe('parseSlash', () => {
  it.each([
    ['/help', { name: 'help', args: '' }],
    ['  /mode   plan  ', { name: 'mode', args: 'plan' }],
    ['/review main branch', { name: 'review', args: 'main branch' }],
    ['/skill-name do it\nnow', { name: 'skill-name', args: 'do it\nnow' }],
  ])('parses %j', (line, expected) => {
    expect(parseSlash(line)).toEqual(expected);
  });

  it.each(['hello', '/ space', '//path/like', '/'])('does not treat %j as a command', (line) => {
    expect(parseSlash(line)).toBeUndefined();
  });
});

const unusedShell: SlashContext['shell'] = {
  run: async () => 0,
};

const unusedScreen: SlashContext['screen'] = { current: () => 'fullscreen', set: async () => undefined };

const unusedDisplay: SlashContext['display'] = {
  theme: () => 'dark',
  previewTheme: () => undefined,
  storeTheme: async () => undefined,
  notify: () => 'off',
  storeNotify: async () => undefined,
  a11y: () => NO_A11Y,
  storedA11y: () => false,
  storeA11y: async () => undefined,
  pick: async () => undefined,
};

const unusedOverlays: SlashContext['overlays'] = { choose: async () => undefined, promptText: async () => undefined };
const unusedKeyBindings: SlashContext['keyBindings'] = { store: fixedKeyBindings(DEFAULT_KEY_TABLE), choose: async () => undefined, captureKey: async () => undefined };

const unusedAutoMode: SlashContext['autoMode'] = {
  check: async () => ({ measurement: 'passed' }),
  status: async () => ({ measurement: 'not_measured' }),
};

describe('registry', () => {
  const registry = createSlashRegistry(BUILTIN_SLASH_COMMANDS);

  it('finds commands by name and by their other names', () => {
    expect(registry.find('exit')?.name).toBe('exit');
    expect(registry.find('quit')?.name).toBe('exit');
    expect(registry.find('nope')).toBeUndefined();
  });

  it('offers at least help, mode, model and exit, and clear and resume in the default set', () => {
    expect(registry.list().map((command) => command.name)).toEqual(expect.arrayContaining(['help', 'mode', 'model', 'exit']));
    expect(DEFAULT_SLASH_COMMANDS.map((command) => command.name)).toEqual(expect.arrayContaining(['clear', 'resume']));
    expect(createSlashRegistry(DEFAULT_SLASH_COMMANDS).find('new')?.name).toBe('clear');
  });
});

const GEMMA = 'ollama/gemma-3-4b:latest';
const QWEN = 'ollama/qwen3.8:27b';

describe('built-in commands', () => {
  const contextOf = (overrides: Partial<SlashContext> = {}, backendOptions: FakeBackendOptions = {}): { context: SlashContext; infos: string[]; modes: string[]; models: string[] } => {
    const infos: string[] = [];
    const modes: string[] = [];
    const models: string[] = [];
    const context: SlashContext = {
      mode: 'manual',
      model: SESSION.model,
      found: createFoundServers(),
      wait: <T>(_phase: string, work: (signal: AbortSignal) => Promise<T>) => work(new AbortController().signal),
      toast: () => undefined,
      refreshConnection: async () => undefined,
      bypassAllowed: false,
      autoAvailable: false,
      commands: BUILTIN_SLASH_COMMANDS,
      backend: fakeBackend(backendOptions),
      startRun: async () => undefined,
      compact: async () => undefined,
      info: (text) => void infos.push(text),
      sessions: { startNew: async () => void infos.push('new session'), resume: async (id) => void infos.push(`resumed ${id}`), now: () => 0, columns: () => 80 },
      exit: () => void infos.push('exited'),
      setMode: async (mode) => void modes.push(mode),
      setModel: async (model) => void models.push(model),
      background: (_label, work) => work(new AbortController().signal),
      autoMode: unusedAutoMode,
      shell: unusedShell,
      screen: unusedScreen,
      keys: DEFAULT_KEY_TABLE,
      negotiation: 'unknown',
      display: unusedDisplay,
      keyBindings: unusedKeyBindings,
      overlays: unusedOverlays,
      refusedWhileRunning: () => false,
      status: () => [],
      ...overrides,
    };
    return { context, infos, modes, models };
  };
  const run = (name: string, args: string, context: SlashContext) => createSlashRegistry(BUILTIN_SLASH_COMMANDS).find(name)?.run(args, context);

  it('/mode without an argument shows the current mode and the choices, without auto', async () => {
    const { context, infos } = contextOf({ mode: 'plan' });
    await run('mode', '', context);
    expect(infos[0]).toContain('permission mode: plan');
    expect(infos[0]).toContain('acceptEdits');
    expect(infos[0]).not.toContain('auto');
  });

  it('/mode lists auto when a classifier is configured', async () => {
    const { context, infos } = contextOf({ autoAvailable: true });
    await run('mode', '', context);
    expect(infos[0]).toBe('permission mode: manual (available: manual, acceptEdits, plan, auto)');
  });

  it('/mode sets a known mode and refuses an unknown one', async () => {
    const { context, infos, modes } = contextOf();
    await run('mode', 'acceptEdits', context);
    await run('mode', 'turbo', context);
    expect(modes).toEqual(['acceptEdits']);
    expect(infos).toEqual(['unknown permission mode turbo; available: manual, acceptEdits, plan']);
  });

  it('/mode manual sets the asking mode, and /mode default is refused with the list of valid modes', async () => {
    const { context, infos, modes } = contextOf({ mode: 'plan' });
    await run('mode', 'manual', context);
    await run('mode', 'default', context);
    expect(modes).toEqual(['manual']);
    expect(infos).toEqual(['unknown permission mode default; available: manual, acceptEdits, plan']);
  });

  it('/model without an argument lists the configured models by display name with the current one marked and says when a switch applies', async () => {
    const { context, infos } = contextOf({ model: QWEN }, { models: [GEMMA, QWEN], windows: { [GEMMA]: 8192, [QWEN]: 32768 } });
    await run('model', '', context);
    expect(infos).toEqual([
      ['models (the current one is marked *):', '    gemma-3-4b  8192-token window', '  * qwen3.8:27b  32768-token window', 'switch with /model <model>; a change applies from the next task'].join('\n'),
    ]);
  });

  it('/model switches to a listed model by its typed name and refuses one that is not configured with the sentence of the resolver', async () => {
    const { context, infos, models } = contextOf({}, { models: [GEMMA, QWEN] });
    await run('model', 'qwen3.8:27b', context);
    await run('model', 'turbo', context);
    expect(models).toEqual([QWEN]);
    expect(infos).toEqual(['The model "turbo" is not configured. Configured models: gemma-3-4b, qwen3.8:27b.']);
  });

  it('/model is described in the help with its usage', async () => {
    const { context, infos } = contextOf();
    await run('help', '', context);
    expect(infos[0]).toContain('/model [model] [--start]  list the configured models with the current one marked, or switch the model from the next task');
  });

  it('/clear, /resume <id> and /exit call their hooks', async () => {
    const { context, infos } = contextOf();
    const all = createSlashRegistry(DEFAULT_SLASH_COMMANDS);
    await all.find('clear')?.run('', context);
    await all.find('resume')?.run('0123456789abcdef', context);
    await run('quit', '', context);
    expect(infos).toEqual(['new session', 'resumed 0123456789abcdef', 'exited']);
  });
});

const PDF: SkillView = { name: 'pdf', description: 'Extract PDF text', scope: 'project', location: '/p/.agents/skills/pdf/SKILL.md' };
const PR: SkillView = { name: 'pr-review', description: 'Review a pull request', scope: 'user', location: '/h/.agents/skills/pr-review/SKILL.md' };

const MEMORY: MemoryView = {
  id: 'mem-1',
  scope: 'project',
  origin: 'trusted',
  project: '/work/project',
  text: 'The build uses pnpm.\nSecond line.',
  source: { kind: 'tool', sessionId: 's1', runId: 'r1', step: 2, callId: 'c1', seq: 9 },
  createdAt: 0,
  keptAt: 1000,
  kind: 'fact',
  state: 'active',
  duplicateOf: null,
  supersedes: [],
  supersededBy: [],
  retiredAt: null,
  evidence: [],
  contributedAt: null,
  status: 'unbound',
};

const contextWith = (backendOptions: FakeBackendOptions = {}) => {
  const infos: string[] = [];
  const runs: { text: string; skill?: string }[] = [];
  const backend = fakeBackend(backendOptions);
  const context: SlashContext = {
    mode: 'manual',
    model: SESSION.model,
    found: createFoundServers(),
    wait: <T>(_phase: string, work: (signal: AbortSignal) => Promise<T>) => work(new AbortController().signal),
    toast: () => undefined,
    refreshConnection: async () => undefined,
    bypassAllowed: false,
    autoAvailable: false,
    commands: DEFAULT_SLASH_COMMANDS,
    backend,
    info: (text) => void infos.push(text),
    startRun: async (text, options) => void runs.push({ text, ...options }),
    compact: async () => undefined,
    sessions: { startNew: async () => undefined, resume: async () => undefined, now: () => 0, columns: () => 80 },
    exit: () => undefined,
    setMode: async () => undefined,
    setModel: async () => undefined,
    background: (_label, work) => work(new AbortController().signal),
    autoMode: unusedAutoMode,
    shell: unusedShell,
    screen: unusedScreen,
    keys: DEFAULT_KEY_TABLE,
    negotiation: 'unknown',
    display: unusedDisplay,
    keyBindings: unusedKeyBindings,
    overlays: unusedOverlays,
    refusedWhileRunning: () => false,
    status: () => [],
  };
  return { context, infos, runs, backend };
};

describe('/help', () => {
  const commands = createSlashRegistry([...BUILTIN_SLASH_COMMANDS, ...skillCommands([PDF], new Set()).commands]).list();
  const help = (negotiation: Parameters<typeof helpText>[0]['negotiation'], screen: 'fullscreen' | 'scrollback' = 'fullscreen'): string[] => helpText({ commands, keys: DEFAULT_KEY_TABLE, negotiation, screen }).split('\n');

  it.each(['kitty', 'proven'] as const)('names shift+enter for a new line once the terminal reports it (%s)', (negotiation) => {
    expect(newlineHelpLines(DEFAULT_KEY_TABLE, negotiation)).toEqual(['shift+enter or ctrl+j: new line', 'alt+enter: new line where the terminal sends Alt as Escape', '\\ then enter: new line']);
  });

  it.each(['unknown', 'plain', 'modify-other-keys'] as const)('names only ctrl+j while shift+enter is not proven (%s)', (negotiation) => {
    expect(newlineHelpLines(DEFAULT_KEY_TABLE, negotiation)).toEqual([
      'ctrl+j: new line (shift+enter works only if this terminal reports it; this one has not)',
      'alt+enter: new line where the terminal sends Alt as Escape',
      '\\ then enter: new line',
    ]);
  });

  it('groups the commands of the registry, the keys of the table and the mouse actions', () => {
    const lines = help('unknown');
    expect(lines.filter((line) => !line.startsWith('  '))).toEqual(['Commands', 'Keys', 'Mouse']);
    expect(lines.slice(1, lines.indexOf('Keys'))).toEqual(commands.map((command) => `  /${command.name}${command.usage === undefined ? '' : ` ${command.usage}`}  ${command.description}`));
    for (const line of ['  ctrl+c: cancel the run or clear the input; twice on an empty input to exit', '  ctrl+d: twice on an empty input to exit', '  ctrl+r: search the history', '  ctrl+g: edit the draft in $VISUAL or $EDITOR', '  ctrl+o: show or fold the detail', '  shift+tab: cycles the mode', '  esc: stops the run', '  pageup: scroll up half a screen', '  ctrl+home: go to the top', '  ctrl+l: repaint the screen'])
      expect(lines).toContain(line);
    expect(lines.join('\n')).not.toContain('backslash+enter');
  });

  it('lists every key of the editor, the viewport and the screen that the table holds, and no key of a list', () => {
    const lines = help('kitty');
    const keyLines = lines.slice(lines.indexOf('Keys') + 1, lines.indexOf('Mouse'));
    const expected = DEFAULT_KEY_TABLE.rows().filter((row) => ['chat', 'viewport', 'global'].includes(row.context) && row.id !== 'prompt.newline');
    expect(keyLines).toHaveLength(expected.length + 3);
    for (const row of expected) expect(keyLines).toContain(`  ${DEFAULT_KEY_TABLE.hintFor(row.id)}: ${row.description}`);
    expect(keyLines.join('\n')).not.toContain('complete the highlighted command');
  });

  it('lists the viewport keys and the mouse only in the full screen', () => {
    const lines = help('unknown', 'scrollback');
    expect(lines).not.toContain('Mouse');
    expect(lines).not.toContain('  pageup: scroll up half a screen');
    expect(help('unknown')).toContain('  wheel: scroll');
    expect(help('unknown')).toContain('  click in the input: place the caret');
  });

  it('is what the command prints', async () => {
    const infos: string[] = [];
    const { context } = contextWith();
    await createSlashRegistry(BUILTIN_SLASH_COMMANDS).find('help')?.run('', { ...context, commands, negotiation: 'kitty', info: (text) => void infos.push(text) });
    expect(infos).toEqual([helpText({ commands, keys: DEFAULT_KEY_TABLE, negotiation: 'kitty', screen: 'fullscreen' })]);
  });
});

describe('skill commands', () => {
  it('start a run of the skill with the rest of the line as the task', async () => {
    const { context, runs } = contextWith();
    const { commands } = skillCommands([PDF], new Set());
    await createSlashRegistry(commands).find('pdf')?.run('summarize report.pdf', context);
    expect(runs).toEqual([{ text: 'summarize report.pdf', skill: 'pdf' }]);
  });

  it('ask for the task instead of inventing one', async () => {
    const { context, runs, infos } = contextWith();
    await createSlashRegistry(skillCommands([PDF], new Set()).commands).find('pdf')?.run('', context);
    expect(runs).toEqual([]);
    expect(infos).toEqual(['/pdf needs a task to run the skill on: /pdf <task>']);
  });

  it('leave a skill that shares its name with a taken command to the model and report it', () => {
    const { commands, shadowed } = skillCommands([PDF, { ...PR, name: 'help' }], new Set(['help']));
    expect(commands.map((command) => command.name)).toEqual(['pdf']);
    expect(shadowed).toEqual(['help']);
  });

  it('carry the description of the skill into the help listing', () => {
    expect(skillCommands([PDF], new Set()).commands[0]).toMatchObject({ description: 'Extract PDF text', usage: '<task>' });
  });
});

describe('/memory', () => {
  const memory = createSlashRegistry(DEFAULT_SLASH_COMMANDS).find('memory');

  it('lists, shows and deletes memories through the backend', async () => {
    const { context, infos, backend } = contextWith({ memories: [MEMORY] });
    await memory?.run('', context);
    expect(infos.at(-1)).toBe('mem-1  [project /work/project]  The build uses pnpm.');
    await memory?.run('show mem-1', context);
    expect(infos.at(-1)).toContain('source: session s1, run r1, step 2, call c1, event 9');
    expect(infos.at(-1)).toContain('Second line.');
    await memory?.run('delete mem-1', context);
    expect(backend.calls).toContain('memory-delete:mem-1');
    await memory?.run('list', context);
    expect(infos.at(-1)).toBe('no memories');
  });

  it('prints its usage for anything else', async () => {
    const { context, infos } = contextWith();
    await memory?.run('show', context);
    await memory?.run('forget mem-1', context);
    expect(infos).toEqual(Array(2).fill('usage: /memory [list] | /memory show <id> | /memory delete <id> (retires the memory; it stays in /memory history) | /memory add <text> | /memory history <id> | /memory review | /memory restore <id> | /memory promote <id> --skill <name>'));
  });
});

describe('/memory delete', () => {
  const memory = createSlashRegistry(DEFAULT_SLASH_COMMANDS).find('memory');

  it('says that the memory was retired and stays in the history, and describes itself as retiring', async () => {
    const { context, infos } = contextWith({ memories: [MEMORY] });
    await memory?.run('delete mem-1', context);
    expect(infos.at(-1)).toBe('retired memory mem-1; it stays in /memory history');
    expect(memory?.description).toBe('list, show, add, review, restore, promote or retire the memories of this folder and of all folders');
  });
});
