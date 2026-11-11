import { testKernelLock } from '@momonga/testkit';
import type { EntryIo } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import { freshHome } from './fresh-home.ts';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram, reopenOf } from '../src/program.ts';
import type { UpdatePorts } from '../src/update/ports.ts';
import { GITHUB_ENDPOINTS } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';
import { NO_HELPER } from './no-helper.ts';

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
  const ports = { version: '9.9.9', interrupt: new AbortController().signal, home: freshHome(), cwd: '/c', env: {}, platform: process.platform, terminal: undefined } as unknown as CliPorts;
  const program = buildProgram({
    ports,
    policyVerify: () => nodePolicyVerifyHost(ports, { executables: '/c/cache/executables' }, testKernelLock()),
    entries,
    update: () => ({ ports: { self: { kind: 'script', execPath: '/node', script: '/main.js' } } as unknown as UpdatePorts, build: { repo: undefined, teamId: undefined, publicKey: undefined }, endpoints: GITHUB_ENDPOINTS, checkIntervalMs: 1 }),
    interrupt: new AbortController().signal,
    helper: NO_HELPER,
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
    const flags = ['--home=/h', '--lifeline-fd=3', '--log-target=file', '--worker-count=2'];

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

describe('acp command', () => {
  it('is listed in the help', async () => {
    const { program, out } = harness();
    await run(program, '--help').catch(() => undefined);
    expect(out.join('')).toContain('acp');
  });

  it('refuses to start without the standard streams to speak on', async () => {
    const { program, completed } = harness();
    await expect(run(program, 'acp')).rejects.toThrow('this build has no standard streams to speak the Agent Client Protocol on');
    expect(completed).toEqual([]);
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
    const refused = harness();
    await expect(run(refused.program, '-p', 'x', '--permission-mode', 'default')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(refused.out.join('')).toContain('Allowed choices are manual, acceptEdits, plan, auto, bypassPermissions.');
  });

  it('policy verify --mode refuses default and names the starting mode in its help', async () => {
    const { program, out } = harness();
    const verify = program.commands.find((command) => command.name() === 'policy')?.commands.find((command) => command.name() === 'verify');
    if (verify === undefined) throw new Error('no policy verify command');
    verify.exitOverride().configureOutput({ writeOut: (text) => out.push(text), writeErr: (text) => out.push(text) });
    await expect(run(program, 'policy', 'verify', '--mode', 'default')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
    expect(out.join('')).toContain('Allowed choices are manual, acceptEdits, plan, auto, bypassPermissions.');
    expect(verify.helpInformation().replace(/\s+/g, ' ')).toContain('the permission mode to check; the starting mode of the settings when omitted');
  });

  it('needs a terminal for the interactive session', async () => {
    const { program } = harness();
    await expect(run(program)).rejects.toThrow('the interactive session needs a terminal; pass --print <prompt> to run without one');
  });

  it.each(['rule list', 'memory list', 'mcp list', 'daemon status'])('reads one argument that holds the two words "%s" as the first prompt of an interactive session, and says so when there is no terminal', async (argument) => {
    const { program } = harness();
    await expect(run(program, argument)).rejects.toThrow(`the interactive session needs a terminal; "${argument}" is not the name of a command and was read as its first prompt; pass --print <prompt> to run without one`);
  });

  it('rejects a non-integer --after for attach', async () => {
    const { program } = harness();
    await expect(run(program, 'attach', '--after', 'soon')).rejects.toMatchObject({ code: 'commander.invalidArgument' });
  });
});

describe('the reopen options (9.1)', () => {
  it('reads --resume <id>, --resume and --continue', () => {
    expect(reopenOf({ resume: '0123456789abcdef' })).toEqual({ kind: 'id', id: '0123456789abcdef' });
    expect(reopenOf({ resume: true })).toEqual({ kind: 'pick' });
    expect(reopenOf({ continue: true })).toEqual({ kind: 'newest' });
    expect(reopenOf({})).toBeUndefined();
  });

  it('lists both options in the help', () => {
    const help = harness().program.helpInformation();

    expect(help).toContain('--resume [session-id]');
    expect(help).toContain('--continue');
  });

  it('refuses --resume together with --continue', async () => {
    const { program, out } = harness();

    await expect(run(program, '--resume', '0123456789abcdef', '--continue')).rejects.toThrow();
    expect(out.join('')).toContain("option '--resume [session-id]' cannot be used with option '--continue'");
  });

  it('refuses --print with --resume and no id, since no picker can be shown', async () => {
    const { program } = harness();

    await expect(run(program, '--print', 'go', '--resume')).rejects.toThrow('--resume needs a session id when --print is used');
  });
});
