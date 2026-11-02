import type { EntryIo } from '@momonga/foundation';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
import type { DaemonEntries } from '../src/daemon/entries.ts';
import type { CliPorts } from '../src/ports.ts';
import { buildProgram } from '../src/program.ts';
import { UPDATE_CHECK_COMMAND } from '../src/update/background.ts';
import { assetNameFor } from '../src/update/source.ts';
import { nodePolicyVerifyHost } from '../src/verify/host.ts';
import { NEW_BINARY, setupUpdate } from './update-harness.ts';
import type { HarnessOptions } from './update-harness.ts';

const programFor = async (context: TestContext, options: HarnessOptions = {}) => {
  const harness = await setupUpdate(context, options);
  const completed: number[] = [];
  const stdout: string[] = [];
  const entry = async (): Promise<number> => 0;
  const entries: DaemonEntries = { supervise: entry, gateway: entry, runtime: entry };
  const cli = {
    version: harness.ports.version,
    home: harness.ports.home,
    cwd: harness.ports.home,
    stdout: { write: (text: string) => void stdout.push(text) },
    stderr: harness.ports.stderr,
    clock: harness.ports.clock,
    env: harness.ports.env,
    self: harness.ports.self,
    spawnDetached: harness.ports.spawnDetached,
    terminal: undefined,
  } as unknown as CliPorts;
  const program = buildProgram({
    ports: cli,
    policyVerify: () => nodePolicyVerifyHost(cli, { cacheBase: `${harness.ports.home}/cache` }),
    entries,
    update: () => harness.wiring,
    interrupt: new AbortController().signal,
    entryIo: (args) => ({ argv: [...args] }) as unknown as EntryIo,
    complete: (code) => completed.push(code),
  });
  return { program, harness, completed, stdout };
};

const run = (program: Awaited<ReturnType<typeof programFor>>['program'], ...args: string[]): Promise<unknown> => program.parseAsync(args, { from: 'user' });

describe('momonga update command', () => {
  it('installs the latest release and completes with exit code 0', async (context) => {
    const { program, harness, completed, stdout } = await programFor(context);
    harness.server.publish('v2.0.0', { [assetNameFor(harness.ports.platform, harness.ports.arch)]: NEW_BINARY });

    await run(program, 'update');

    expect(completed).toEqual([0]);
    expect(stdout.join('')).toContain('updated momonga 1.0.0 -> 2.0.0');
    expect(harness.targetBytes().equals(NEW_BINARY)).toBe(true);
    expect(harness.spawned).toHaveLength(0);
  });

  it('reports instead of failing when --check runs ahead of the latest release, and still refuses to install a downgrade', async (context) => {
    const { program, harness, completed, stdout } = await programFor(context);
    harness.server.publish('v0.9.0', { [assetNameFor(harness.ports.platform, harness.ports.arch)]: NEW_BINARY });

    await run(program, 'update', '--check');

    expect(completed).toEqual([0]);
    expect(stdout.join('')).toBe('momonga 1.0.0 is newer than the latest release v0.9.0\n');
    await expect(run(program, 'update')).rejects.toMatchObject({ code: 'downgrade_refused' });
  });

  it('propagates a typed refusal for a build without an update source', async (context) => {
    const { program } = await programFor(context, { build: { repo: undefined, teamId: undefined } });

    await expect(run(program, 'update')).rejects.toMatchObject({ code: 'no_update_source' });
  });

  it('is listed in the help while the internal check is not', async (context) => {
    const { program } = await programFor(context);
    const help = program.helpInformation();
    expect(help).toContain('update');
    expect(help).not.toContain(UPDATE_CHECK_COMMAND);
  });
});

describe('the background check around user commands', () => {
  it('starts before an ordinary command and never before update or an internal command', async (context) => {
    const { program, harness } = await programFor(context);

    await run(program, 'daemon', 'status');
    expect(harness.spawned.map((child) => child.spec.args)).toEqual([[UPDATE_CHECK_COMMAND]]);

    const second = await programFor(context);
    await expect(run(second.program, 'update')).rejects.toThrow();
    await run(second.program, '__supervise');
    expect(second.harness.spawned).toHaveLength(0);
  });

  it('announces an unannounced result on stderr before an ordinary command', async (context) => {
    const { program, harness } = await programFor(context);
    harness.state.value = { checkedAt: 0, outcome: { kind: 'installed', version: '2.0.0' }, announced: false };

    await run(program, 'daemon', 'status');

    expect(harness.stderr.join('')).toContain('momonga: momonga 2.0.0 was installed in the background; you are running 1.0.0');
    expect(harness.state.value).toMatchObject({ announced: true });
  });

  it('leaves the result of the update check to the startup screen before an interactive session', async (context) => {
    const { program, harness } = await programFor(context);
    harness.state.value = { checkedAt: 0, outcome: { kind: 'installed', version: '2.0.0' }, announced: false };

    await expect(run(program)).rejects.toThrow('the interactive session needs a terminal');

    expect(harness.stderr.join('')).toBe('');
    expect(harness.state.value).toMatchObject({ announced: false });
  });

  it('reports a check that cannot be scheduled and still runs the command', async (context) => {
    const { program, harness, completed } = await programFor(context);
    harness.state.value = { nonsense: true };

    await run(program, 'daemon', 'status');

    expect(harness.stderr.join('')).toContain('momonga: the background update check was not started: the update state file is not valid');
    expect(completed).toEqual([1]);
  });

  it('runs the detached check command through the update wiring', async (context) => {
    const { program, harness, completed } = await programFor(context, { version: '2.0.0' });
    harness.server.publish('v2.0.0', { [assetNameFor(harness.ports.platform, harness.ports.arch)]: NEW_BINARY });

    await run(program, UPDATE_CHECK_COMMAND);

    expect(completed).toEqual([0]);
    expect(harness.state.value).toMatchObject({ outcome: { kind: 'up_to_date' } });
  });
});
