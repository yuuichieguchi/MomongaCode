import { describe, expect, it } from 'vitest';
import { BUILTIN_SLASH_COMMANDS, createSlashRegistry, parseSlash } from '../src/tui/slash.ts';
import type { SlashContext } from '../src/tui/slash.ts';

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
      commands: BUILTIN_SLASH_COMMANDS,
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

  it('/mode sets a known mode and refuses an unknown one', async () => {
    const { context, infos, modes } = contextOf();
    await run('mode', 'acceptEdits', context);
    await run('mode', 'turbo', context);
    expect(modes).toEqual(['acceptEdits']);
    expect(infos).toEqual(['unknown permission mode turbo; available: default, acceptEdits, plan, bypassPermissions']);
  });

  it('/clear and /exit call their hooks', async () => {
    const { context, infos } = contextOf();
    await run('clear', '', context);
    await run('quit', '', context);
    expect(infos).toEqual(['cleared', 'exited']);
  });
});
