import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DAEMON_MARKER_FD, LIFELINE_FD, isProcessAlive, FIRST_GENERATION } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS, killGroupsForCleanup, registerCleanup, spawnTracked, waitFor, withTempDir } from '@momonga/testkit';
import { childStdio, contractArgs, resolveLaunch } from '../src/launcher.ts';
import { createManagerHarness } from './support/p2-manager-harness.ts';
import { pollUntil, processGroupOf } from './support/p2-poll.ts';
import { trackedSpawnPort } from './support/tracked-spawn-port.ts';

const CHILD_FIXTURE = fileURLToPath(new URL('./fixtures/p2-child.ts', import.meta.url));
const MANAGER_FIXTURE = fileURLToPath(new URL('./fixtures/p2-manager-fixture.ts', import.meta.url));

const startedChildPids = (logText: string): number[] =>
  logText
    .split('\n')
    .slice(0, -1)
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { msg?: unknown; raw?: unknown })
    .filter((record) => record.msg === 'child.stdout' && typeof record.raw === 'string' && record.raw.startsWith('{'))
    .map((record) => (JSON.parse(String(record.raw)) as { started?: unknown }).started)
    .filter((started): started is number => typeof started === 'number');

describe('contract flags', () => {
  it('launcher appends the contract flags in order', () => {
    expect(contractArgs({ generation: FIRST_GENERATION, role: 'runtime', home: '/h/home' })).toEqual([
      '--home=/h/home',
      `--generation=${FIRST_GENERATION}`,
      `--lifeline-fd=${LIFELINE_FD}`,
      '--log-target=file',
    ]);
    const tuned = contractArgs({
      generation: FIRST_GENERATION,
      role: 'runtime',
      home: '/h/home',
      runtime: { leaseMs: 100, drainTimeoutMs: 200, workerCount: 2, sandboxExecPath: '/usr/bin/sandbox-exec' },
      gateway: { args: ['--fm-binary=/opt/fm'] },
    });
    expect(tuned.slice(0, 4)).toEqual(['--home=/h/home', '--generation=1', '--lifeline-fd=3', '--log-target=file']);
    expect([...tuned.slice(4)].sort()).toEqual(['--drain-timeout-ms=200', '--lease-ms=100', '--sandbox-exec-path=/usr/bin/sandbox-exec', '--worker-count=2']);
    const gateway = contractArgs({ generation: FIRST_GENERATION, role: 'gateway', home: '/h/home', runtime: { leaseMs: 100 }, gateway: { args: ['--fm-binary=/opt/fm'] } });
    expect(gateway).toEqual(['--home=/h/home', '--generation=1', '--lifeline-fd=3', '--log-target=file', '--fm-binary=/opt/fm']);
  });

  it('resolveLaunch puts the launcher args before the contract flags', () => {
    const resolved = resolveLaunch({
      generation: FIRST_GENERATION,
      role: 'gateway',
      launcher: () => ({ command: '/usr/local/bin/node', args: ['__gateway'] }),
      home: '/h',
      baseEnv: { PATH: '/bin' },
      separateEnv: (merged) => merged,
    });
    expect(resolved).toEqual({
      command: '/usr/local/bin/node',
      args: ['__gateway', '--home=/h', '--generation=1', '--lifeline-fd=3', '--log-target=file'],
      env: { PATH: '/bin' },
    });
  });

  it('relative command is rejected', () => {
    for (const command of ['node', './bin/node', '']) {
      expect(() =>
        resolveLaunch({ generation: FIRST_GENERATION, role: 'runtime', launcher: () => ({ command, args: [] }), home: '/h', baseEnv: {}, separateEnv: (merged) => merged }),
      ).toThrow(TypeError);
    }
  });

  it('the separation filter is applied to the merged env', () => {
    const seen: Record<string, string>[] = [];
    const resolved = resolveLaunch({
      generation: FIRST_GENERATION,
      role: 'runtime',
      launcher: () => ({ command: '/bin/node', args: [], env: { OPENAI_API_KEY: 'x', EXTRA: 'e', FOO: 'override' } }),
      home: '/h',
      baseEnv: { FOO: 'base', PATH: '/bin' },
      separateEnv: (merged) => {
        seen.push({ ...merged });
        return Object.fromEntries(Object.entries(merged).filter(([name]) => name !== 'OPENAI_API_KEY'));
      },
    });
    expect(seen).toEqual([{ FOO: 'override', PATH: '/bin', OPENAI_API_KEY: 'x', EXTRA: 'e' }]);
    expect(resolved.env).toEqual({ FOO: 'override', PATH: '/bin', EXTRA: 'e' });
  });
});

describe('stdio layout', () => {
  it('stdio indices are LIFELINE_FD and DAEMON_MARKER_FD', () => {
    const stdio = childStdio(17);
    expect(stdio).toEqual(['ignore', 'pipe', 'pipe', 'pipe', 17]);
    expect(stdio[LIFELINE_FD]).toBe('pipe');
    expect(stdio[DAEMON_MARKER_FD]).toBe(17);
  });

  it('the manager hands spawn the lifeline pipe and the marker fd', (context) => {
    const harness = createManagerHarness(context);
    harness.spawnInitial();
    const options = harness.port.last().options;
    expect(options.stdio[LIFELINE_FD]).toBe('pipe');
    expect(typeof options.stdio[DAEMON_MARKER_FD]).toBe('number');
    expect(options.stdio.slice(0, 3)).toEqual(['ignore', 'pipe', 'pipe']);
  });
});

describe('spawn options', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('children are spawned detached', (context) => {
    const harness = createManagerHarness(context);
    harness.spawnInitial();
    const call = harness.port.calls[0];
    expect(call?.options.detached).toBe(true);
    expect(call?.options.cwd).toBe(harness.home);
    expect(call?.command).toBe(process.execPath);
    expect(call?.args).toEqual(['/opt/momonga/fixture-bin.ts', `--home=${harness.home}`, '--generation=1', '--lifeline-fd=3', '--log-target=file']);
  });

  it('children are spawned detached: the real child leads its own group', async (context) => {
    const port = trackedSpawnPort(context);
    const harness = createManagerHarness(context, { port, launcher: () => ({ command: process.execPath, args: [CHILD_FIXTURE] }) });
    harness.spawnInitial();
    const pid = port.spawned[0]?.pid;
    expect(typeof pid).toBe('number');
    const childPid = pid as number;
    expect(processGroupOf(childPid)).toBe(childPid);
    expect(processGroupOf(childPid)).not.toBe(processGroupOf(process.pid));
  });

  it('relative command is rejected and handled as a spawn failure', async (context) => {
    const harness = createManagerHarness(context, { launcher: () => ({ command: 'node', args: [] }) });
    harness.spawnInitial();
    await waitFor(() => harness.manager.state() === 'backoff');
    expect(harness.spawnCount()).toBe(0);
    expect(harness.manager.health().lastExit).toMatchObject({ code: null, signal: null, reason: 'spawn-failed' });
    expect(harness.markers()).toEqual([]);
  });

  it('launcher env cannot re-add a credential', (context) => {
    const runtime = createManagerHarness(context, {
      role: 'runtime',
      launcher: () => ({ command: process.execPath, args: [], env: { OPENAI_API_KEY: 'x', LAUNCHER_EXTRA: 'kept' } }),
    });
    runtime.spawnInitial();
    const runtimeEnv = runtime.port.last().options.env;
    expect(runtimeEnv).not.toHaveProperty('OPENAI_API_KEY');
    expect(runtimeEnv['LAUNCHER_EXTRA']).toBe('kept');
    expect(runtimeEnv['FOO']).toBe('foo');
    const gateway = createManagerHarness(context, {
      role: 'gateway',
      launcher: () => ({ command: process.execPath, args: [], env: { UNDECLARED_X: 'y', NODE_OPTIONS: '--inspect' } }),
    });
    gateway.spawnInitial();
    const gatewayEnv = gateway.port.last().options.env;
    expect(gatewayEnv).not.toHaveProperty('UNDECLARED_X');
    expect(gatewayEnv).not.toHaveProperty('NODE_OPTIONS');
    expect(gatewayEnv).not.toHaveProperty('FOO');
    expect(gatewayEnv['PATH']).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
  });
});

describe('signals with real processes', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it('a group SIGTERM to the supervisor\'s group does not reach a child', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const termFile = path.join(home, 'terms.log');
    const supervisor = spawnTracked(context, process.execPath, [MANAGER_FIXTURE, `--home=${home}`, `--child=${CHILD_FIXTURE}`, `--child-arg=--p2-count-term=${termFile}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childGroups = new Set<number>();
    registerCleanup(context, async () => {
      const groups = [...childGroups];
      await killGroupsForCleanup(groups);
      const survivors = groups.filter((pgid) => isProcessAlive(pgid));
      if (survivors.length > 0) throw new Error(`fixture children still alive after cleanup: ${survivors.join(', ')}`);
    });
    let output = '';
    supervisor.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      for (const match of output.matchAll(/"childPid":(\d+)/g)) childGroups.add(Number(match[1]));
    });
    let errors = '';
    const childStartedPids = new Set<number>();
    let onChildStarted = (): void => undefined;
    supervisor.stderr?.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
      for (const pid of startedChildPids(errors)) {
        childStartedPids.add(pid);
        childGroups.add(pid);
      }
      onChildStarted();
    });
    let exited = false;
    supervisor.once('exit', () => {
      exited = true;
      onChildStarted();
    });
    await pollUntil(() => exited || /"childPid":\d+/.test(output), 5000, 'fixture supervisor reports its child');
    const match = /"childPid":(\d+)/.exec(output);
    expect(match, errors).not.toBeNull();
    const childPid = Number(match?.[1]);
    await new Promise<void>((resolve) => {
      onChildStarted = () => {
        if (exited || childStartedPids.has(childPid)) resolve();
      };
      onChildStarted();
    });
    expect(childStartedPids.has(childPid), errors).toBe(true);
    expect(processGroupOf(childPid)).not.toBe(supervisor.pid);
    process.kill(-supervisor.pid, 'SIGTERM');
    await pollUntil(() => !isProcessAlive(childPid), 5000, 'child exits after the supervisor stops it');
    expect(fs.readFileSync(termFile, 'utf8')).toBe('TERM\n');
  });

  it('the SIGKILL stage kills the child\'s group', async (context) => {
    const port = trackedSpawnPort(context);
    const harness = createManagerHarness(context, {
      port,
      launcher: () => ({ command: process.execPath, args: [CHILD_FIXTURE, '--p2-ignore-term', '--p2-grandchild=group'] }),
    });
    harness.spawnInitial();
    await pollUntil(() => harness.events('child.stdout').some((line) => String(line['raw']).includes('grandchild')), 5000, 'grandchild reported');
    const raw = harness.events('child.stdout').find((line) => String(line['raw']).includes('grandchild'))?.['raw'];
    const grandchild = (JSON.parse(String(raw)) as { grandchild: number }).grandchild;
    const childPid = port.spawned[0]?.pid as number;
    expect(processGroupOf(grandchild)).toBe(childPid);
    const stopped = harness.manager.stop('shutdown', 'term');
    harness.timers.advance(50_000);
    await pollUntil(() => !isProcessAlive(childPid) && !isProcessAlive(grandchild), 5000, 'child and grandchild are gone');
    await expect(stopped).resolves.toMatchObject({ killed: true, leaked: false });
  });
});
