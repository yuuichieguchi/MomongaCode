import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LSOF_PATH, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { HAS_REAL_SANDBOX, keyFor, noneSandbox } from '../helpers.ts';
import { approvalOf, isAlive, makeBuiltins, onCleanup, resultOf, trackGroup, trackPid, waitFor } from './fixtures.ts';
import type { Builtins } from './fixtures.ts';
import { bashTool, MAX_BACKGROUND_TIMEOUT_MS, MAX_TIMEOUT_MS } from '../../src/builtins/bash.ts';

const PROCESS_TIMEOUT = { timeout: REAL_PROCESS_TEST_TIMEOUT_MS };

const bash = async (tools: Builtins, command: string, extra: Parameters<Builtins['run']>[2] = {}, callId?: string) =>
  tools.run('Bash', { command }, extra, 'allow_once', callId);

const attachedGroups = (tools: Builtins): number[] =>
  tools.idempotency.log.flatMap((entry) => (entry.op === 'attachProcess' ? [entry.pgid] : []));

const holdersOf = (file: string): number[] => {
  try {
    return execFileSync(LSOF_PATH, ['-t', '--', file], { env: { LC_ALL: 'C' }, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line !== '')
      .map(Number);
  } catch {
    return [];
  }
};

const groupsOf = (pids: readonly number[]): number[] => {
  const listing = new Map(
    execFileSync('/bin/ps', ['-A', '-o', 'pid=,pgid='], { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => line.trim().split(/\s+/).map(Number) as [number, number]),
  );
  return pids.flatMap((pid) => (listing.has(pid) ? [listing.get(pid) as number] : []));
};

const processesWithArgument = (argument: string): number[] =>
  execFileSync('/bin/ps', ['-A', '-o', 'pid=,args='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.includes(argument))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => pid !== process.pid);

describe.runIf(HAS_REAL_SANDBOX)('Bash (real sandbox)', () => {
  it('runs the command and returns its output without the cwd marker', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const result = resultOf(await bash(tools, 'echo hello'));
    expect(result.status).toBe('completed');
    expect(result.output.trimEnd()).toBe('hello');
    expect(result.output).not.toContain('__MOMONGA_CWD_');
  });

  it('captures stdout and stderr', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const result = resultOf(await bash(tools, 'echo to-out; echo to-err 1>&2'));
    expect(result.output).toContain('to-out');
    expect(result.output).toContain('to-err');
  });

  it('fails with the exit code for a non-zero exit', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const result = resultOf(await bash(tools, 'echo before; exit 3'));
    expect(result.status).toBe('failed');
    expect(result.output).toContain('before');
    expect(result.output.trimEnd().endsWith('[exit code 3]')).toBe(true);
  });

  it.for([
    ['exit 0', 'completed', 0],
    ['exit 3', 'failed', 3],
  ] as const)('reports the exit code of %s as a structured fact', PROCESS_TIMEOUT, async ([command, status, exitCode]) => {
    const tools = await makeBuiltins({ realSandbox: true });
    const result = resultOf(await bash(tools, command));
    expect(result).toMatchObject({ status, exitCode });
  });

  it('reports the exit code the sandbox reports for a shell killed by a signal: none under Seatbelt, 128 + 9 from bubblewrap, which exits for its child', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const SIGKILL_EXIT_FROM_BUBBLEWRAP = 137;
    expect(resultOf(await bash(tools, 'kill -9 $$')).exitCode).toBe(process.platform === 'darwin' ? undefined : SIGKILL_EXIT_FROM_BUBBLEWRAP);
  });

  it('fails with the signal name when the shell is killed by a signal', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const result = resultOf(await bash(tools, 'kill -9 $$'));
    expect(result.status).toBe('failed');
    const reported = process.platform === 'darwin' ? '[terminated by SIGKILL]' : '[exit code 137]';
    expect(result.output.trimEnd().endsWith(reported)).toBe(true);
  });

  it('runs in the session cwd', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const sub = path.join(tools.layout.project, 'sub');
    fs.mkdirSync(sub);
    tools.session.cwd = sub;
    const result = resultOf(await bash(tools, 'pwd -P'));
    expect(result.output.trimEnd()).toBe(sub);
  });

  it('persists a cd inside the roots into the session cwd', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const sub = path.join(tools.layout.project, 'sub');
    fs.mkdirSync(sub);
    resultOf(await bash(tools, 'cd sub'));
    expect(tools.session.cwd).toBe(sub);
    const next = resultOf(await bash(tools, 'pwd -P'));
    expect(next.output.trimEnd()).toBe(sub);
  });

  it('resets a cd outside the roots and says so', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const result = resultOf(await bash(tools, `cd ${tools.layout.outside}`));
    expect(tools.session.cwd).toBe(tools.layout.project);
    expect(result.output.trimEnd().endsWith('Shell cwd was reset to .')).toBe(true);
    expect(result.output).not.toContain('__MOMONGA_CWD_');
  });

  it('keeps the cwd when the shell dies before printing the marker', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    fs.mkdirSync(path.join(tools.layout.project, 'sub'));
    resultOf(await bash(tools, 'cd sub; kill -9 $$'));
    expect(tools.session.cwd).toBe(tools.layout.project);
  });

  it('says the cwd could not be determined when the command replaces the shell', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const result = resultOf(await bash(tools, 'mkdir -p sub && cd sub && exec true'));
    expect(tools.session.cwd).toBe(tools.layout.project);
    expect(result.output).toContain('Shell cwd could not be determined and stays at .');
  });

  it('does not let a fake marker printed by the command change the cwd', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const sub = path.join(tools.layout.project, 'sub');
    fs.mkdirSync(sub);
    resultOf(await bash(tools, `echo "__MOMONGA_CWD_0000__=${sub}"`));
    expect(tools.session.cwd).toBe(tools.layout.project);
  });

  it('builds the environment from ctx.env plus the git and pager overrides', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const env = { PATH: '/usr/bin:/bin', MOMONGA_PROBE: 'probe-value', PAGER: 'less', CDPATH: '/tmp' };
    const result = resultOf(await bash(tools, 'env', { env }));
    const lines = result.output.split('\n');
    expect(lines).toContain('MOMONGA_PROBE=probe-value');
    expect(lines).toContain('PATH=/usr/bin:/bin');
    expect(lines).toContain('GIT_TERMINAL_PROMPT=0');
    expect(lines).toContain('PAGER=cat');
    expect(lines).toContain('GIT_PAGER=cat');
    expect(lines).toContain('CDPATH=');
    expect(lines.some((line) => line.startsWith('HOME='))).toBe(false);
    expect(lines.some((line) => line.startsWith('USER='))).toBe(false);
  });

  it('does not inherit stdin', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const result = resultOf(await bash(tools, 'if read -r -t 10 line; then echo "got:$line"; else echo "status:$?"; fi'));
    expect(result.output.trimEnd()).toBe('status:1');
  });

  it('cannot write outside the roots', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const target = path.join(tools.layout.outside, 'escape.txt');
    const result = resultOf(await bash(tools, `echo x > ${target}`, { mode: 'bypassPermissions' }));
    expect(result.status).toBe('failed');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('can write inside the roots and the configured tmp dir', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const inRoot = path.join(tools.layout.project, 'ok.txt');
    const inTmp = path.join(tools.tmpDir, 'ok.txt');
    const result = resultOf(await bash(tools, `echo a > ${inRoot} && echo b > ${inTmp}`));
    expect(result.status).toBe('completed');
    expect(fs.readFileSync(inRoot, 'utf8')).toBe('a\n');
    expect(fs.readFileSync(inTmp, 'utf8')).toBe('b\n');
  });

  it('is blocked by the sandbox from writing a protected path even after approval', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    fs.mkdirSync(path.join(tools.layout.project, '.git', 'hooks'), { recursive: true });
    const hook = path.join(tools.layout.project, '.git', 'hooks', 'pre-commit');
    const result = resultOf(await bash(tools, 'echo evil > .git/hooks/pre-commit'));
    expect(result.status).toBe('failed');
    expect(fs.existsSync(hook)).toBe(false);
  });

  it('cannot read readDenied paths', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const secret = path.join(tools.layout.home, '.momonga', 'token');
    fs.mkdirSync(path.dirname(secret));
    fs.writeFileSync(secret, 'top-secret-value');
    const result = resultOf(await bash(tools, `cat ${secret}`, { mode: 'bypassPermissions' }));
    expect(result.status).toBe('failed');
    expect(result.output).not.toContain('top-secret-value');
  });

  it('has no network access', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    onCleanup(() => server.close());
    const port = (server.address() as net.AddressInfo).port;
    const result = resultOf(await bash(tools, `exec 5<>/dev/tcp/127.0.0.1/${port} && echo connected`));
    expect(result.status).toBe('failed');
    expect(result.output).not.toContain('connected');
    expect(connections).toBe(0);
  });

  it('records the process group through attachProcess right after spawn', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const callId = 'attach';
    const result = resultOf(await bash(tools, 'echo $$', {}, callId));
    const entries = tools.idempotency.log.filter((entry) => entry.op === 'attachProcess');
    const innerPid = Number(result.output.trim());
    expect(entries).toEqual([{ op: 'attachProcess', key: keyFor('run-1', 1, callId), pgid: process.platform === 'darwin' ? innerPid : expect.any(Number), startedAt: tools.clock.now() }]);
    expect(entries[0]?.pgid).toBeGreaterThan(1);
    if (process.platform !== 'darwin') expect(entries[0]?.pgid).not.toBe(innerPid);
  });

  it('passes the process marker so the child holds it', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const callId = 'marker';
    const marker = path.join(tools.markerDir, keyFor('run-1', 1, callId));
    const ready = path.join(tools.layout.project, 'ready');
    const go = path.join(tools.layout.project, 'go');
    const running = bash(tools, `touch ${ready}; while [ ! -e ${go} ]; do sleep 0.05; done; echo done`, {}, callId);
    expect(await waitFor(() => fs.existsSync(ready), 10_000)).toBe(true);
    const groups = attachedGroups(tools);
    groups.forEach(trackGroup);
    expect(groups).toHaveLength(1);
    const holders = holdersOf(marker);
    if (process.platform === 'darwin') {
      expect(holders).toContain(groups[0]);
    } else {
      const heldGroups = groupsOf(holders);
      expect(heldGroups.length).toBeGreaterThan(0);
      expect(new Set(heldGroups)).toEqual(new Set([groups[0]]));
    }
    fs.writeFileSync(go, '');
    expect(resultOf(await running).output.trimEnd()).toBe('done');
  });

  it('kills the whole process group on timeout', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const childPidFile = path.join(tools.layout.project, 'child.pid');
    const command = `sleep 30 & echo $! > ${childPidFile}; wait`;
    const outcome = await tools.run('Bash', { command, timeout: 1000 }, {}, 'allow_once');
    const result = resultOf(outcome);
    expect(result).toEqual({ status: 'failed', command, output: 'Bash timed out after 1000 ms. Its side effects are unknown; inspect the current state before retrying.' });
    const [pgid] = attachedGroups(tools);
    expect(typeof pgid).toBe('number');
    const child = Number(fs.readFileSync(childPidFile, 'utf8').trim());
    trackPid(child);
    expect(await waitFor(() => !isAlive(-(pgid as number)) && !isAlive(child), 5000)).toBe(true);
  });

  it('kills the whole process group on cancel', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const ready = path.join(tools.layout.project, 'ready');
    const controller = new AbortController();
    const command = `sleep 30 & echo $! > ${ready}.tmp; mv ${ready}.tmp ${ready}; wait`;
    const running = tools.executor.runBatch(tools.batch('Bash', { command }, { signal: controller.signal }, 'allow_once'));
    expect(await waitFor(() => fs.existsSync(ready), 10_000)).toBe(true);
    const child = Number(fs.readFileSync(ready, 'utf8').trim());
    trackPid(child);
    const [pgid] = attachedGroups(tools);
    expect(typeof pgid).toBe('number');
    trackGroup(pgid as number);
    controller.abort();
    const [outcome] = await running;
    expect(resultOf(outcome)).toEqual({ status: 'failed', command, output: 'Bash was cancelled. Its side effects are unknown; inspect the current state before retrying.' });
    expect(await waitFor(() => !isAlive(-(pgid as number)) && !isAlive(child), 5000)).toBe(true);
  });

  it('terminates an escaped setsid process that kept the marker and reports it', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const ready = path.join(tools.layout.project, 'escaped');
    const script = `perl -e 'use POSIX; POSIX::setsid(); open(my $f, ">", $ARGV[0]); close $f; sleep 30' ${ready} >/dev/null 2>&1 & while [ ! -e ${ready} ]; do sleep 0.05; done; echo "pid:$!"`;
    const result = resultOf(await bash(tools, script));
    const pid = Number(/pid:(\d+)/.exec(result.output)?.[1]);
    if (process.platform === 'darwin') {
      trackPid(pid);
      expect(result.output).toContain('Terminated 1 process(es) that outlived the command.');
      expect(await waitFor(() => !isAlive(pid), 5000)).toBe(true);
      return;
    }
    expect(result.output).not.toContain('outlived the command');
    expect(await waitFor(() => processesWithArgument(ready).length === 0, 5000)).toBe(true);
  });

  it('known limitation: a setsid process that closed fd 3 outlives the command', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const ready = path.join(tools.layout.project, 'escaped');
    const script = `perl -e 'use POSIX; POSIX::setsid(); open(my $f, ">", $ARGV[0]); close $f; sleep 30' ${ready} >/dev/null 2>&1 3>&- & while [ ! -e ${ready} ]; do sleep 0.05; done; echo "pid:$!"`;
    const result = resultOf(await bash(tools, script));
    const pid = Number(/pid:(\d+)/.exec(result.output)?.[1]);
    expect(result.output).not.toContain('outlived the command');
    if (process.platform === 'darwin') {
      trackPid(pid);
      expect(isAlive(pid)).toBe(true);
      return;
    }
    expect(await waitFor(() => processesWithArgument(ready).length === 0, 5000)).toBe(true);
  });

  it('keeps large output bounded with a head, tail and omitted-bytes marker', PROCESS_TIMEOUT, async () => {
    const tools = await makeBuiltins({ realSandbox: true });
    const result = resultOf(await bash(tools, 'echo FIRST-LINE; yes 0123456789 | head -c 10000000; echo LAST-LINE'));
    const full = [...tools.blobs.stored.values()].map((entry) => entry.text).find((text) => text.includes('FIRST-LINE'));
    expect(result.status).toBe('completed');
    expect(full).toBeDefined();
    expect(full).toMatch(/\[… \d+ bytes omitted …\]/);
    expect(full?.startsWith('FIRST-LINE\n')).toBe(true);
    expect(full).toContain('LAST-LINE');
    expect(Buffer.byteLength(full ?? '')).toBeLessThanOrEqual(8 * 1024 * 1024 + 4096);
    expect(Buffer.byteLength(full ?? '')).toBeGreaterThan(8 * 1024 * 1024 - 4096);
  });

  describe('reconcile of an interrupted call', () => {
    it('kills a surviving group that holds the marker and reports unknown without rerunning', PROCESS_TIMEOUT, async () => {
      const tools = await makeBuiltins({ realSandbox: true });
      const callId = 'interrupted';
      const key = keyFor('run-1', 1, callId);
      const marker = path.join(tools.markerDir, key);
      fs.writeFileSync(marker, '', { mode: 0o600 });
      const ready = path.join(tools.layout.root, 'survivor-ready');
      const fd = fs.openSync(marker, 'r');
      let pgid: number;
      try {
        const child = spawn('/bin/sh', ['-c', `touch "${ready}"; sleep 60`], { detached: true, stdio: ['ignore', 'ignore', 'ignore', fd], env: { PATH: '/usr/bin:/bin' } });
        child.unref();
        pgid = child.pid as number;
      } finally {
        fs.closeSync(fd);
      }
      trackGroup(pgid);
      expect(await waitFor(() => fs.existsSync(ready), 5000)).toBe(true);
      tools.idempotency.seed(key, 'PENDING', { tool: 'Bash' });
      tools.idempotency.port.attachProcess(key, { pgid, startedAt: tools.clock.now() - 500 });
      const executed = path.join(tools.layout.project, 'executed');
      const outcome = await bash(tools, `touch ${executed}`, {}, callId);
      expect(outcome).toMatchObject({ kind: 'result', reconciled: 'unknown', result: { status: 'failed' } });
      expect(resultOf(outcome).output).toContain('The interrupted command was stopped.');
      expect(resultOf(outcome).output).not.toContain('no longer running');
      expect(fs.existsSync(executed)).toBe(false);
      expect(await waitFor(() => !isAlive(-pgid), 5000)).toBe(true);
    });

    it('reports unknown when the record has no process group', PROCESS_TIMEOUT, async () => {
      const tools = await makeBuiltins({ realSandbox: true });
      const callId = 'never-attached';
      tools.idempotency.seed(keyFor('run-1', 1, callId), 'PENDING', { tool: 'Bash' });
      const executed = path.join(tools.layout.project, 'executed');
      const outcome = await bash(tools, `touch ${executed}`, {}, callId);
      expect(outcome).toMatchObject({ kind: 'result', reconciled: 'unknown', result: { status: 'failed' } });
      expect(resultOf(outcome).output).toMatch(/may or may not have started/);
      expect(fs.existsSync(executed)).toBe(false);
    });
  });
});

describe('Bash admission and metadata', () => {
  it('uses the description as the title', async () => {
    const tools = await makeBuiltins();
    const outcome = approvalOf(await tools.run('Bash', { command: 'make build', description: 'Build it' }));
    expect(outcome.title).toBe('Build it');
    expect(outcome.toolKind).toBe('execute');
  });

  it('cuts the command to 80 characters for the title', async () => {
    const tools = await makeBuiltins();
    const command = `make ${'x'.repeat(120)}`;
    const outcome = approvalOf(await tools.run('Bash', { command }));
    expect(outcome.title).toBe(command.slice(0, 80));
  });

  it('suggests a rule for the command when asking under Seatbelt', async () => {
    const tools = await makeBuiltins();
    const outcome = approvalOf(await tools.run('Bash', { command: 'make test' }));
    expect(outcome.suggestedRule).toBeDefined();
  });

  it('refuses a foreground timeout above the maximum and names the limit', async () => {
    const tools = await makeBuiltins();
    const result = resultOf(await tools.run('Bash', { command: 'true', timeout: 1_800_000 }, { mode: 'bypassPermissions' }));
    expect(result.status).toBe('failed');
    expect(result.output).toContain('600000');
  });

  it('states in the schema the same limits as in the description', () => {
    const tool = bashTool;
    const properties = tool.inputSchema['properties'] as Record<string, { description: string }>;
    expect(properties['timeout']?.description).toContain(String(MAX_TIMEOUT_MS));
    expect(properties['timeout']?.description).toContain(String(MAX_BACKGROUND_TIMEOUT_MS));
    expect(tool.description).toContain(String(MAX_TIMEOUT_MS));
  });

  it.each([0, 600_001, 1.5])('rejects timeout %s', async (timeout) => {
    const tools = await makeBuiltins();
    const result = resultOf(await tools.run('Bash', { command: 'true', timeout }, { mode: 'bypassPermissions' }));
    expect(result.status).toBe('failed');
  });

  it('forces approval when the sandbox kind is none even in bypass mode', async () => {
    const tools = await makeBuiltins();
    const outcome = approvalOf(await tools.run('Bash', { command: 'echo hi' }, { mode: 'bypassPermissions', sandbox: noneSandbox }));
    expect(outcome.decision.kind).toBe('ask');
    expect('suggestedRule' in outcome).toBe(false);
  });
});
