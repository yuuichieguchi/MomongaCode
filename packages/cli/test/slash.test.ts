import { describe, expect, it } from 'vitest';
import type { MemoryView, SkillView } from '@momonga/protocol';
import { DEFAULT_SLASH_COMMANDS } from '../src/tui/commands/index.ts';
import { skillCommands } from '../src/tui/commands/skills.ts';
import { BUILTIN_SLASH_COMMANDS, createSlashRegistry, parseSlash, slashCompletion } from '../src/tui/slash.ts';
import type { SlashContext } from '../src/tui/slash.ts';
import { fakeBackend } from './fake-backend.ts';
import type { FakeBackendOptions } from './fake-backend.ts';

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

describe('registry', () => {
  const registry = createSlashRegistry(BUILTIN_SLASH_COMMANDS);

  it('finds commands by name and by alias', () => {
    expect(registry.find('exit')?.name).toBe('exit');
    expect(registry.find('quit')?.name).toBe('exit');
    expect(registry.find('nope')).toBeUndefined();
  });

  it('offers at least help, clear, mode and exit', () => {
    expect(registry.list().map((command) => command.name)).toEqual(expect.arrayContaining(['help', 'clear', 'mode', 'exit']));
  });
});

describe('built-in commands', () => {
  const contextOf = (overrides: Partial<SlashContext> = {}): { context: SlashContext; infos: string[]; modes: string[] } => {
    const infos: string[] = [];
    const modes: string[] = [];
    const context: SlashContext = {
      mode: 'default',
      bypassAllowed: false,
      autoAvailable: false,
      commands: BUILTIN_SLASH_COMMANDS,
      backend: fakeBackend(),
      startRun: async () => undefined,
      info: (text) => void infos.push(text),
      clear: () => void infos.push('cleared'),
      exit: () => void infos.push('exited'),
      setMode: async (mode) => void modes.push(mode),
      ...overrides,
    };
    return { context, infos, modes };
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
    expect(infos[0]).toBe('permission mode: default (available: default, acceptEdits, plan, auto)');
  });

  it('/mode sets a known mode and refuses an unknown one', async () => {
    const { context, infos, modes } = contextOf();
    await run('mode', 'acceptEdits', context);
    await run('mode', 'turbo', context);
    expect(modes).toEqual(['acceptEdits']);
    expect(infos).toEqual(['unknown permission mode turbo; available: default, acceptEdits, plan']);
  });

  it('/clear and /exit call their hooks', async () => {
    const { context, infos } = contextOf();
    await run('clear', '', context);
    await run('quit', '', context);
    expect(infos).toEqual(['cleared', 'exited']);
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
  source: { sessionId: 's1', runId: 'r1', step: 2, callId: 'c1', seq: 9 },
  createdAt: 0,
  lastUsedAt: 1000,
};

const contextWith = (backendOptions: FakeBackendOptions = {}) => {
  const infos: string[] = [];
  const runs: { text: string; skill?: string }[] = [];
  const backend = fakeBackend(backendOptions);
  const context: SlashContext = {
    mode: 'default',
    bypassAllowed: false,
    autoAvailable: false,
    commands: DEFAULT_SLASH_COMMANDS,
    backend,
    info: (text) => void infos.push(text),
    startRun: async (text, options) => void runs.push({ text, ...options }),
    clear: () => undefined,
    exit: () => undefined,
    setMode: async () => undefined,
  };
  return { context, infos, runs, backend };
};

describe('slashCompletion', () => {
  const commands = createSlashRegistry([...BUILTIN_SLASH_COMMANDS, ...skillCommands([PDF, PR], new Set()).commands]).list();

  it('lists every command that starts with what was typed and completes the longest common prefix', () => {
    expect(slashCompletion('/', commands)?.names).toEqual(['help', 'clear', 'mode', 'exit', 'pdf', 'pr-review']);
    expect(slashCompletion('/p', commands)).toEqual({ names: ['pdf', 'pr-review'], completed: '/p' });
    expect(slashCompletion('/pr', commands)).toEqual({ names: ['pr-review'], completed: '/pr-review ' });
  });

  it('offers nothing for text that is not a bare command name or has no match', () => {
    expect(slashCompletion('/pdf summarize', commands)).toBeUndefined();
    expect(slashCompletion('hello', commands)).toBeUndefined();
    expect(slashCompletion('/zzz', commands)).toBeUndefined();
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
    expect(infos).toEqual(Array(2).fill('usage: /memory [list] | /memory show <id> | /memory delete <id>'));
  });
});
