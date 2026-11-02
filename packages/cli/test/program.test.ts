import type { EntryIo } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';

const IO = { name: 'io' } as unknown as EntryIo;

const harness = () => {
  const received: Record<string, readonly string[]> = {};
  const completed: number[] = [];
  const out: string[] = [];
  const entryFor = (name: string) => async (io: EntryIo): Promise<number> => {
    received[name] = io.argv;
    return 7;
  };
  const entries: DaemonEntries = { supervise: entryFor('supervise'), gateway: entryFor('gateway'), runtime: entryFor('runtime') };
  const ports = { version: '9.9.9', home: '/h', cwd: '/c', terminal: undefined } as unknown as CliPorts;
  const program = buildProgram({
    ports,
    entries,
    update: { ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 },
    interrupt: new AbortController().signal,
    entryIo: (args) => ({ ...IO, argv: [...args] }) as EntryIo,
    complete: (code) => completed.push(code),
  });
  program.exitOverride().configureOutput({ writeOut: (text) => out.push(text), writeErr: (text) => out.push(text) });
  for (const command of program.commands) {
    command.exitOverride();
    command.configureOutput({ writeOut: (text) => out.push(text), writeErr: (text) => out.push(text) });
  }
  return { program, received, completed, out };
};

const run = (program: ReturnType<typeof harness>['program'], ...args: string[]): Promise<unknown> => program.parseAsync(args, { from: 'user' });

describe('internal daemon commands', () => {
  it.each(['__supervise', '__gateway', '__runtime'])('%s receives its flags untouched, as the supervisor contract passes them', async (name) => {
    const { program, received, completed } = harness();
    const flags = ['--app-version=1.0.0', '--home=/h', '--lifeline-fd=3', '--log-target=file', '--worker-count=2'];

    await run(program, name, ...flags);

    expect(received[name.slice(2)]).toEqual(flags);
    expect(completed).toEqual([7]);
  });

  it('keeps them out of the help', async () => {
    const { program, out } = harness();
    await run(program, '--help').catch(() => undefined);
    expect(out.join('')).not.toContain('__gateway');
    expect(out.join('')).toContain('attach');
    expect(out.join('')).toContain('gateway');
  });
});

describe('root command', () => {
  it('prints the version it was built with', async () => {
    const { program, out } = harness();
    await run(program, '--version').catch(() => undefined);
    expect(out.join('')).toBe('9.9.9\n');
  });

  it('rejects an unknown output format and permission mode', async () => {
    const { program } = harness();
    await expect(run(program, '-p', 'x', '--output-format', 'xml')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    await expect(run(harness().program, '-p', 'x', '--permission-mode', 'yolo')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
  });

  it('needs a terminal for the interactive session', async () => {
    const { program } = harness();
    await expect(run(program)).rejects.toThrow('the interactive session needs a terminal; pass --print <prompt> to run without one');
  });

  it('rejects a non-integer --after for attach', async () => {
    const { program } = harness();
    await expect(run(program, 'attach', '--after', 'soon')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
  });
});
