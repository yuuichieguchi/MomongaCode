import { execFileSync, spawn } from 'node:child_process';
import type { SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupMembersReader } from '@momonga/foundation';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET, groupTerminationBoundMs } from '@momonga/foundation';
import { SandboxPolicyError, createBubblewrapSandbox, createPlaceholderJournal } from '@momonga/sandbox';
import type { SandboxPolicy } from '@momonga/sandbox';
import { REAL_PROCESS_TEST_TIMEOUT_MS, waitFor } from '@momonga/testkit';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const FAKE_BWRAP = `#!/bin/sh
while [ "$1" != "--" ]; do
  if [ "$1" = "--ro-bind" ] && [ "$2" = "/dev/null" ] && [ ! -e "$3" ]; then : > "$3"; fi
  shift
done
shift
exec "$@"
`;

let base = '';
let work = '';
let bwrap = '';

beforeEach(() => {
  base = fs.realpathSync(makeTempDir());
  work = path.join(base, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(base, 'tmp'));
  bwrap = path.join(base, 'bwrap');
  fs.writeFileSync(bwrap, FAKE_BWRAP, { mode: 0o755 });
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const policy = (writeDenied: string[]): SandboxPolicy => ({
  writableRoots: [work],
  writeDenied,
  writeDeniedLiterals: [],
  readDenied: [],
  network: 'deny',
  fileRules: EMPTY_FILE_RULES,
  protectedSet: EMPTY_PROTECTED_SET,
});

const journal = () => createPlaceholderJournal(path.join(base, 'journal'));

const sandbox = () => createBubblewrapSandbox({ bwrapPath: bwrap, tmpRoot: path.join(base, 'tmp'), killGraceMs: 300, journal: journal(), holders: () => new Set() });

describe('bubblewrap launch (a stand-in bwrap that creates the /dev/null mount points; the real bwrap is exercised in bubblewrap-real.test.ts)', () => {
  it('refuses to start a command in a workspace whose protected .git is a symlink loop, with a typed error that names it', () => {
    const git = path.join(work, '.git');
    fs.symlinkSync('.git', git);
    const looped = { ...policy([]), writeDeniedLiterals: [git] };
    let thrown: unknown;
    try {
      sandbox().spawn({ argv: ['/bin/sh', '-c', 'echo started'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, looped, new AbortController().signal);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SandboxPolicyError);
    expect((thrown as SandboxPolicyError).message).toContain(git);
    expect(fs.lstatSync(git).isSymbolicLink()).toBe(true);
  });

  it('forwards the command stdin to the sandboxed process, as Seatbelt and the unsandboxed launcher do', async () => {
    const proc = sandbox().spawn({ argv: ['/bin/cat'], cwd: work, env: { PATH: '/usr/bin:/bin' }, stdin: '{"tool_input":1}' }, policy([]), new AbortController().signal);
    const result = await run(proc);
    expect(result.stdout).toBe('{"tool_input":1}');
    expect(result.code).toBe(0);
  });

  it('holds a placeholder for a protected path that does not exist yet while the command runs and removes it afterwards', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const proc = sandbox().spawn(
      { argv: ['/bin/sh', '-c', 'test -f .git && ! mkdir .git 2>/dev/null && echo pinned'], cwd: work, env: { PATH: '/usr/bin:/bin' } },
      policy([hooks]),
      new AbortController().signal,
    );
    const result = await run(proc);
    expect(result.stdout.trim()).toBe('pinned');
    expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
  });

  it('removes the placeholder and the private tmp dir when the child reports an asynchronous error, and only once even if it then exits', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const failure = new Error('child could not be signalled');
    const failing = createBubblewrapSandbox({
      bwrapPath: bwrap,
      tmpRoot: path.join(base, 'tmp'),
      killGraceMs: 300,
      journal: journal(),
      holders: () => new Set(),
      spawnProcess: ((file, args, spawnOptions) => {
        const child = spawn(file, args as string[], spawnOptions as SpawnOptions);
        setImmediate(() => child.emit('error', failure));
        return child;
      }) as typeof spawn,
    });
    const proc = failing.spawn({ argv: ['/bin/sh', '-c', 'exec sleep 30'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy([hooks]), new AbortController().signal);
    await expect(proc.exited).rejects.toBe(failure);
    expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
    expect(fs.readdirSync(path.join(base, 'tmp'))).toEqual([]);
  });

  it('keeps a placeholder until the last command that reserved it has exited', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const shared = sandbox();
    const gate = path.join(base, 'gate');
    execFileSync('/usr/bin/mkfifo', [gate]);
    const first = shared.spawn({ argv: ['/bin/cat', gate], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy([hooks]), new AbortController().signal);
    const second = shared.spawn({ argv: ['/bin/sh', '-c', 'true'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy([hooks]), new AbortController().signal);
    await run(second);
    expect(fs.existsSync(path.join(work, '.git'))).toBe(true);
    fs.writeFileSync(gate, 'open');
    await run(first);
    expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
  });

  it('keeps a placeholder that an earlier command created until the later command that planned around it has exited', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const shared = sandbox();
    const gates = [path.join(base, 'gate-first'), path.join(base, 'gate-second')];
    for (const gate of gates) execFileSync('/usr/bin/mkfifo', [gate]);
    const waiting = (name: string, gate: string) => ({ argv: ['/bin/sh', '-c', `: > ${path.join(base, name)}; cat ${gate}`], cwd: work, env: { PATH: '/usr/bin:/bin' } });
    const announced = (name: string): Promise<void> => waitFor(() => fs.existsSync(path.join(base, name)));

    const first = shared.spawn(waiting('first-ready', gates[0] as string), policy([hooks]), new AbortController().signal);
    await announced('first-ready');
    expect(fs.statSync(path.join(work, '.git')).isFile()).toBe(true);
    const second = shared.spawn(waiting('second-ready', gates[1] as string), policy([hooks]), new AbortController().signal);
    await announced('second-ready');

    fs.writeFileSync(gates[0] as string, 'open');
    await run(first);
    expect(fs.existsSync(path.join(work, '.git'))).toBe(true);
    fs.writeFileSync(gates[1] as string, 'open');
    await run(second);
    expect(fs.existsSync(path.join(work, '.git'))).toBe(false);
  });

  it('never deletes a placeholder path that holds content', async () => {
    const hooks = path.join(work, '.git', 'hooks');
    const proc = sandbox().spawn({ argv: ['/bin/sh', '-c', 'echo kept > .git'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy([hooks]), new AbortController().signal);
    await run(proc);
    expect(fs.readFileSync(path.join(work, '.git'), 'utf8')).toBe('kept\n');
  });
});

const MONITORING_BWRAP = `#!/bin/sh
while [ "$1" != "--" ]; do shift; done
shift
"$@" &
child=$!
trap 'kill -KILL 0' TERM
wait $child
`;

const SETTING_UP_BWRAP = `#!/bin/sh
trap 'kill -KILL 0' TERM
exec 9< "$SETUP_GATE"
while [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`;

const psRows = (): Array<{ pid: number; groupId: number; startTicks: bigint }> =>
  execFileSync('/bin/ps', ['-A', '-o', 'pid=,pgid=,lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } })
    .split('\n')
    .flatMap((line) => {
      const row = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      const startMs = row === null ? Number.NaN : Date.parse(row[3] as string);
      return row === null || Number.isNaN(startMs) ? [] : [{ pid: Number(row[1]), groupId: Number(row[2]), startTicks: BigInt(startMs) }];
    });

const psGroupMembers: GroupMembersReader = {
  members: (pgid) => psRows().flatMap(({ pid, groupId, startTicks }) => (groupId === pgid ? [{ pid, startTicks }] : [])),
  statOf: (pid) => psRows().find((row) => row.pid === pid),
};

describe('bubblewrap cancel (a stand-in bwrap that, like bwrap --die-with-parent, runs the command as its child, dies of SIGTERM and takes the sandbox down with it)', () => {
  const GRACE_MS = 300;

  const cancelAfterReady = async (script: (ready: string) => string): Promise<{ elapsedMs: number; exit: Awaited<ReturnType<typeof run>> }> => {
    const monitoring = path.join(base, 'monitoring-bwrap');
    fs.writeFileSync(monitoring, MONITORING_BWRAP, { mode: 0o755 });
    const monitored = createBubblewrapSandbox({
      bwrapPath: monitoring,
      tmpRoot: path.join(base, 'tmp'),
      killGraceMs: GRACE_MS,
      journal: journal(),
      holders: () => new Set(),
      groupMembers: psGroupMembers,
    });
    const ready = path.join(base, 'ready');
    const controller = new AbortController();
    const proc = monitored.spawn({ argv: ['/bin/sh', '-c', script(ready)], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy([]), controller.signal);
    const finished = run(proc);
    await waitFor(() => fs.existsSync(ready), { description: 'the command is ready' });
    const abortedAt = Date.now();
    controller.abort();
    const exit = await finished;
    return { elapsedMs: Date.now() - abortedAt, exit };
  };

  it('gives a command that ignores SIGTERM the whole kill grace before SIGKILL, because bwrap itself is not sent SIGTERM', async () => {
    const { elapsedMs, exit } = await cancelAfterReady((ready) => `trap '' TERM; : > ${ready}; sleep 30`);
    expect(elapsedMs).toBeGreaterThanOrEqual(GRACE_MS);
    expect(exit.killedBy).toBe('grace-kill');
  });

  it('sends SIGTERM to bwrap itself when the abort comes before bwrap has started the command, because no command waits for the grace', async () => {
    const monitoring = path.join(base, 'monitoring-bwrap');
    fs.writeFileSync(monitoring, SETTING_UP_BWRAP, { mode: 0o755 });
    const gate = path.join(base, 'setup-gate');
    execFileSync('/usr/bin/mkfifo', [gate]);
    const monitored = createBubblewrapSandbox({
      bwrapPath: monitoring,
      tmpRoot: path.join(base, 'tmp'),
      killGraceMs: GRACE_MS,
      journal: journal(),
      holders: () => new Set(),
      groupMembers: psGroupMembers,
    });
    const controller = new AbortController();
    const proc = monitored.spawn({ argv: ['/bin/sh', '-c', 'sleep 30'], cwd: work, env: { PATH: '/usr/bin:/bin', SETUP_GATE: gate } }, policy([]), controller.signal);
    const finished = run(proc);
    await waitFor(() => psGroupMembers.members(proc.pgid).length === 1, { description: 'bwrap is setting up alone in its group' });
    const abortedAt = Date.now();
    controller.abort();
    const exit = await finished;
    expect(Date.now() - abortedAt).toBeLessThanOrEqual(groupTerminationBoundMs(GRACE_MS));
    expect(exit.killedBy).toBe('abort');
  });

  it('sends SIGTERM to the command, which stops before the grace ends, and bwrap reports its death as 128 + the signal', async () => {
    const { elapsedMs, exit } = await cancelAfterReady((ready) => `: > ${ready}; sleep 30`);
    expect(elapsedMs).toBeLessThanOrEqual(groupTerminationBoundMs(GRACE_MS));
    expect(exit.killedBy).toBe('abort');
    expect(exit.code).toBe(143);
  });
});
