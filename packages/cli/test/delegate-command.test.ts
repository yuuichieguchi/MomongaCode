import { describe, expect, it } from 'vitest';
import { DELEGATE_USAGE, delegateCommand } from '../src/tui/commands/delegate.ts';
import { DEFAULT_SLASH_COMMANDS } from '../src/tui/commands/index.ts';
import type { SlashContext } from '../src/tui/slash.ts';

const contextOf = (running = false) => {
  const started: Array<{ text: string; options: unknown }> = [];
  const said: string[] = [];
  const context = {
    refusedWhileRunning: () => running,
    info: (text: string) => void said.push(text),
    startRun: async (text: string, options?: unknown) => void started.push({ text, options }),
  } as unknown as SlashContext;
  return { context, started, said };
};

describe('/delegate', () => {
  it('is one of the default slash commands', () => {
    expect(DEFAULT_SLASH_COMMANDS.map((command) => command.name)).toContain('delegate');
  });

  it('starts the task as a run under the named mandate', async () => {
    const { context, started } = contextOf();
    await delegateCommand.run('nightly fix the flaky test  and push', context);
    expect(started).toEqual([{ text: 'fix the flaky test and push', options: { mandate: { profile: 'nightly' } } }]);
  });

  it.each(['', 'nightly', '   '])('shows how it is used and starts nothing for %j', async (args) => {
    const { context, started, said } = contextOf();
    await delegateCommand.run(args, context);
    expect(started).toEqual([]);
    expect(said).toEqual([DELEGATE_USAGE]);
  });

  it('starts nothing while a run is working', async () => {
    const { context, started } = contextOf(true);
    await delegateCommand.run('nightly do it', context);
    expect(started).toEqual([]);
  });
});
