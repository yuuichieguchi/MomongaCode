import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_FILE_RULES, EMPTY_PROTECTED_SET } from '@momonga/foundation';
import { SOCKET_FILTER_SLOT, SOCKET_GUARD_CHANNEL_SLOT, SandboxPolicyError, bubblewrapCommandOf, createBubblewrapSandbox, createPlaceholderJournal, planBubblewrap, socketFilter, socketFilterArchitectureOf } from '@momonga/sandbox';
import type { BubblewrapPlan, SandboxPolicy } from '@momonga/sandbox';
import { NEVER_CANCELLED, REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeTempDir, run } from './helpers.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

const PRINT_THE_FILTER = `#!/bin/sh
slot=
while [ "$1" != "--" ]; do
  if [ "$1" = "--seccomp" ]; then slot=$2; fi
  shift
done
od -An -v -tx1 <&"$slot" | tr -d ' \\n'
`;

const PRINT_WHAT_THE_GUARD_GETS = `#!/bin/sh
printf '%s\\n' "$@"
printf 'filter '
od -An -v -tx1 <&${SOCKET_FILTER_SLOT} | tr -d ' \\n'
`;

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

let base = '';
let work = '';

beforeEach(() => {
  base = fs.realpathSync(makeTempDir());
  work = path.join(base, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(base, 'tmp'));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const policy = (overrides: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  writableRoots: [work],
  writeDenied: [],
  writeDeniedLiterals: [],
  readDenied: [],
  network: 'deny',
  fileRules: EMPTY_FILE_RULES,
  protectedSet: EMPTY_PROTECTED_SET,
  ...overrides,
});

const executable = (name: string, text: string): string => {
  const file = path.join(base, name);
  fs.writeFileSync(file, text, { mode: 0o755 });
  return file;
};

const PLAN: BubblewrapPlan = { args: ['--unshare-net', '--chdir', '/w'], placeholders: [], forms: {}, sockets: { kind: 'no-unix-sockets' } };

describe('the Unix socket rule of the Linux plan', () => {
  it('names no socket when the allow list is empty, and leaves the mounts as they were', async () => {
    const plan = await planBubblewrap(policy({ unixSocketAllow: [] }), { cwd: work }, NEVER_CANCELLED);

    expect(plan.sockets).toEqual({ kind: 'no-unix-sockets' });
    expect(plan.args.slice(-2)).toEqual(['--chdir', work]);
    expect(plan.args).not.toContain('--seccomp');
  });

  it('names each listed path by its real location, and every read-denied path as closed whatever is listed', async () => {
    const real = path.join(base, 'sockets');
    const owned = path.join(base, 'owned');
    fs.mkdirSync(real);
    fs.mkdirSync(owned);
    fs.symlinkSync(real, path.join(base, 'link'));
    const plan = await planBubblewrap(policy({ unixSocketAllow: [path.join(base, 'link'), real], readDenied: [owned] }), { cwd: work }, NEVER_CANCELLED);

    expect(plan.sockets).toEqual({ kind: 'named-unix-sockets', allowed: [real], denied: [owned] });
  });
});

describe('the command the Linux sandbox starts', () => {
  it('is bwrap with the socket filter on its slot when no socket is named', () => {
    expect(bubblewrapCommandOf('/usr/bin/bwrap', PLAN, ['/bin/sh', '-c', 'true'], '/x/guard')).toEqual({
      file: '/usr/bin/bwrap',
      args: ['--unshare-net', '--chdir', '/w', '--seccomp', String(SOCKET_FILTER_SLOT), '--', '/bin/sh', '-c', 'true'],
      socketFilter: 'no-unix-sockets',
    });
  });

  it('is the socket guard around bwrap when a socket is named: the guard outside answers, and the guard inside installs the filter before the command', () => {
    const named: BubblewrapPlan = { ...PLAN, sockets: { kind: 'named-unix-sockets', allowed: ['/run/a.sock', '/srv/s'], denied: ['/home/u/.momonga'] } };

    expect(bubblewrapCommandOf('/usr/bin/bwrap', named, ['/bin/sh', '-c', 'true'], '/x/guard')).toEqual({
      file: '/x/guard',
      args: [
        'supervise',
        String(SOCKET_GUARD_CHANNEL_SLOT),
        '--allow',
        '/run/a.sock',
        '--allow',
        '/srv/s',
        '--deny',
        '/home/u/.momonga',
        '--',
        '/usr/bin/bwrap',
        '--unshare-net',
        '--chdir',
        '/w',
        '--',
        '/x/guard',
        'enter',
        String(SOCKET_FILTER_SLOT),
        String(SOCKET_GUARD_CHANNEL_SLOT),
        '--',
        '/bin/sh',
        '-c',
        'true',
      ],
      socketFilter: 'named-unix-sockets',
    });
    expect(SOCKET_FILTER_SLOT).toBe(4);
    expect(SOCKET_GUARD_CHANNEL_SLOT).toBe(5);
  });

  it('is refused with the reason when a socket is named and there is no socket guard', () => {
    const named: BubblewrapPlan = { ...PLAN, sockets: { kind: 'named-unix-sockets', allowed: ['/run/a.sock'], denied: [] } };
    let thrown: unknown;
    try {
      bubblewrapCommandOf('/usr/bin/bwrap', named, ['/bin/true'], undefined);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxPolicyError);
    expect((thrown as SandboxPolicyError).code).toBe('socket_guard_missing');
    expect((thrown as SandboxPolicyError).message).toBe(
      'the command may reach the Unix sockets under /run/a.sock, which the Linux sandbox allows only through its socket guard, and this installation has no socket guard, so the command was not started',
    );
  });
});

describe('the socket filter reaches the program that installs it', () => {
  const architecture = socketFilterArchitectureOf(process.arch);
  const sandboxWith = (bwrapPath: string, socketGuard?: string) =>
    createBubblewrapSandbox({
      bwrapPath,
      tmpRoot: path.join(base, 'tmp'),
      killGraceMs: 300,
      journal: createPlaceholderJournal(path.join(base, 'journal')),
      holders: () => new Set(),
      ...(socketGuard === undefined ? {} : { socketGuard: () => socketGuard }),
    });

  it('bwrap reads the filter that refuses every Unix socket from the slot its arguments name', async () => {
    const bwrap = executable('bwrap', PRINT_THE_FILTER);
    const result = await run(await sandboxWith(bwrap).spawn({ argv: ['/bin/true'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy(), new AbortController().signal));

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(hexOf(socketFilter(architecture, 'no-unix-sockets')));
  });

  it('the guard is started with the listed paths and reads the filter that hands connect and bind to it', async () => {
    const bwrap = executable('bwrap', PRINT_THE_FILTER);
    const guard = executable('guard', PRINT_WHAT_THE_GUARD_GETS);
    const listed = path.join(base, 'sockets');
    fs.mkdirSync(listed);
    const result = await run(await sandboxWith(bwrap, guard).spawn({ argv: ['/bin/true'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy({ unixSocketAllow: [listed] }), new AbortController().signal));
    const lines = result.stdout.split('\n');

    expect(result.stderr).toBe('');
    expect(lines.slice(0, 5)).toEqual(['supervise', String(SOCKET_GUARD_CHANNEL_SLOT), '--allow', listed, '--']);
    expect(lines[5]).toBe(bwrap);
    expect(lines.slice(-7)).toEqual([guard, 'enter', String(SOCKET_FILTER_SLOT), String(SOCKET_GUARD_CHANNEL_SLOT), '--', '/bin/true', `filter ${hexOf(socketFilter(architecture, 'named-unix-sockets'))}`]);
  });

  it('a command that names a socket is not started when the sandbox was given no guard', async () => {
    const bwrap = executable('bwrap', PRINT_THE_FILTER);
    const listed = path.join(base, 'sockets');
    fs.mkdirSync(listed);

    await expect(sandboxWith(bwrap).spawn({ argv: ['/bin/true'], cwd: work, env: { PATH: '/usr/bin:/bin' } }, policy({ unixSocketAllow: [listed] }), new AbortController().signal)).rejects.toMatchObject({
      code: 'socket_guard_missing',
    });
    expect(fs.readdirSync(path.join(base, 'tmp'))).toEqual([]);
  });
});
