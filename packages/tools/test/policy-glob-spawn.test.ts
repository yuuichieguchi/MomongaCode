import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { protectedSetFor, ruleEnforcementOf } from '@momonga/foundation';
import { MAX_GLOB_MATCHES, computeFileRules, createGlobDeadline, decide, prepareGlobs, settleGlobs, askedBy } from '@momonga/policy';
import type { DecideInput, GlobDeadline } from '@momonga/policy';
import { REAL_PROCESS_TEST_TIMEOUT_MS, TEST_SEARCH_PATH, isWritableFor, testProbes, NEVER_CANCELLED } from '@momonga/testkit';
import { createPolicyFilesystem } from '@momonga/tools';
import type { ChildPorts, ChildSpawnOptions, PortChild } from '@momonga/tools';
import { makeRealWorkspace } from './real-workspace.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

class FakeChild extends EventEmitter implements PortChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  unrefs = 0;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }

  unref(): void {
    this.unrefs += 1;
  }

  output(...chunks: Buffer[]): void {
    for (const chunk of chunks) this.stdout.emit('data', chunk);
  }

  exit(status: number | null): void {
    this.emit('close', status);
  }
}

type FakeTimer = { callback: () => void; ms: number; cleared: boolean };

type Spawned = { file: string; args: readonly string[]; options: ChildSpawnOptions };

const fakePorts = () => {
  const children: FakeChild[] = [];
  const spawned: Spawned[] = [];
  const timers: FakeTimer[] = [];
  let reached: () => void = () => undefined;
  const firstSpawn = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const ports: ChildPorts = {
    spawn: (file, args, options) => {
      reached();
      const child = new FakeChild();
      children.push(child);
      spawned.push({ file, args, options });
      return child;
    },
    setTimeout: (callback, ms) => {
      timers.push({ callback, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimeout: (handle) => {
      const timer = timers[handle as number];
      if (timer !== undefined) timer.cleared = true;
    },
  };
  return { ports, children, spawned, timers, firstSpawn };
};

type AskedDeadline = GlobDeadline & { asked: Promise<void> };

const deadlineOf = (remaining: number): AskedDeadline => {
  let reached: () => void = () => undefined;
  const asked = new Promise<void>((resolve) => {
    reached = resolve;
  });
  return {
    asked,
    remainingMs: () => {
      reached();
      return remaining;
    },
  };
};

const SHELLS = { isExecutable: () => true, env: {} };

const NEVER_ABORTED = new AbortController().signal;

const expanderWith = (ports: ChildPorts, signal: AbortSignal = NEVER_ABORTED) => {
  const expand = createPolicyFilesystem('linux', SHELLS, ports).expandGlob;
  return (pattern: string, cwd: string, limit: number, deadline: GlobDeadline) => expand(pattern, cwd, limit, deadline, signal);
};

class StreamlessChild extends EventEmitter {
  readonly signals: NodeJS.Signals[] = [];
  stdout = undefined;
  stderr = undefined;
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return true;
  }
  unref(): void {}
}

const DYNAMIC = { unresolvable: { kind: 'dynamic' } };

describe('expandGlob stays inside the decision budget (HIGH-1)', () => {
  it('arms one timer for what is left of the deadline, and clears it once the child has finished', async () => {
    const { ports, children, timers } = fakePorts();
    const budget = deadlineOf(1_234);
    const pending = expanderWith(ports)('*', '/', 10, budget);
    await budget.asked;
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ ms: 1_234, cleared: false });
    children[0]?.output(Buffer.from('a\0'));
    children[0]?.exit(0);
    expect(await pending).toEqual({ matches: ['a'] });
    expect(timers[0]?.cleared).toBe(true);
  });

  it('gives dynamic without a spawn when the deadline is spent', async () => {
    const { ports, spawned } = fakePorts();
    expect(await expanderWith(ports)('*', '/', 10, deadlineOf(0))).toEqual(DYNAMIC);
    expect(spawned).toEqual([]);
  });

  it('kills the child, stops waiting for it and gives dynamic at the deadline, although the child never exits', async () => {
    const { ports, children, timers } = fakePorts();
    const budget = deadlineOf(50);
    const pending = expanderWith(ports)('*', '/', 10, budget);
    await budget.asked;
    timers[0]?.callback();
    expect(await pending).toEqual(DYNAMIC);
    expect(children[0]?.signals).toEqual(['SIGKILL']);
    expect(children[0]?.unrefs).toBe(1);
    expect(children[0]?.stdout.destroyed).toBe(true);
    expect(children[0]?.stderr.destroyed).toBe(true);
  });

  it('ignores an exit, an error and output that arrive after the deadline', async () => {
    const { ports, children, timers } = fakePorts();
    const budget = deadlineOf(50);
    const pending = expanderWith(ports)('*', '/', 10, budget);
    await budget.asked;
    timers[0]?.callback();
    children[0]?.output(Buffer.from('late\0'));
    children[0]?.exit(0);
    children[0]?.emit('error', Object.assign(new Error('EIO: late'), { code: 'EIO' }));
    expect(await pending).toEqual(DYNAMIC);
  });

  it('a child that ignores termination does not hold the decision past the deadline', async () => {
    const workspace = makeRealWorkspace();
    workspace.write('a1', '');
    const { ports, children, timers, firstSpawn } = fakePorts();
    const host = createPolicyFilesystem('linux', SHELLS, ports);
    const pending = prepareGlobs({
      expand: host.expandGlob,
      platform: 'darwin',
      subject: { kind: 'command', tool: 'Bash', command: 'cat a*' },
      cwd: workspace.project,
      home: workspace.home,
      deadline: createGlobDeadline(50),
      signal: NEVER_ABORTED,
    });
    await firstSpawn;
    timers[0]?.callback();
    const globs = await pending;
    expect(children).toHaveLength(1);
    const roots = [workspace.project];
    const input: DecideInput = {
      tool: { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' },
      subject: { kind: 'command', tool: 'Bash', command: 'cat a*' },
      mode: 'manual',
      rules: [],
      roots,
      home: workspace.home,
      cwd: workspace.project,
      fileRules: await computeFileRules([], roots, null, ruleEnforcementOf('none'), testProbes()),
      protectedSet: await protectedSetFor(roots, askedBy(host, NEVER_CANCELLED)),
      fs: settleGlobs(host, globs, NEVER_CANCELLED),
      searchPath: TEST_SEARCH_PATH,
      isWritable: isWritableFor(roots),
    };
    expect(await decide(input)).toMatchObject({ kind: 'ask' });
  });

  it('spends the whole budget once across the words of a decision: the second word finds nothing left', async () => {
    const { ports, children, timers, spawned, firstSpawn } = fakePorts();
    let remaining = 100;
    const deadline: GlobDeadline = { remainingMs: () => remaining };
    const pending = prepareGlobs({
      expand: expanderWith(ports),
      platform: 'darwin',
      subject: { kind: 'command', tool: 'Bash', command: 'cat a* b*' },
      cwd: '/work',
      home: '/home/user',
      deadline,
      signal: NEVER_ABORTED,
    });
    await firstSpawn;
    children[0]?.output(Buffer.from('a1\0'));
    remaining = 0;
    children[0]?.exit(0);
    const globs = await pending;
    expect(spawned).toHaveLength(1);
    expect(timers).toHaveLength(1);
    const settled = settleGlobs(createPolicyFilesystem('linux', SHELLS, ports), globs, NEVER_CANCELLED);
    expect(settled.expandGlob('a*', '/work', MAX_GLOB_MATCHES)).toEqual({ matches: ['a1'] });
    expect(settled.expandGlob('b*', '/work', MAX_GLOB_MATCHES)).toEqual(DYNAMIC);
  });
});

describe('expandGlob counts what the child prints (HIGH-1)', () => {
  it('overflows and kills the child as soon as more than limit names have arrived, without waiting for it to exit', async () => {
    const { ports, children } = fakePorts();
    const budget = deadlineOf(1_000);
    const pending = expanderWith(ports)('*', '/', 2, budget);
    await budget.asked;
    children[0]?.output(Buffer.from('a\0b\0'));
    expect(children[0]?.signals).toEqual([]);
    children[0]?.output(Buffer.from('c\0'));
    expect(await pending).toEqual({ overflow: true });
    expect(children[0]?.signals).toEqual(['SIGKILL']);
  });

  it('counts a name that is split over two chunks once', async () => {
    const { ports, children } = fakePorts();
    const budget = deadlineOf(1_000);
    const pending = expanderWith(ports)('*', '/', 2, budget);
    await budget.asked;
    children[0]?.output(Buffer.from('ab'), Buffer.from('c\0d\0'));
    children[0]?.exit(0);
    expect(await pending).toEqual({ matches: ['abc', 'd'] });
  });

  it('control: exactly limit names are matches', async () => {
    const { ports, children } = fakePorts();
    const budget = deadlineOf(1_000);
    const pending = expanderWith(ports)('*', '/', 2, budget);
    await budget.asked;
    children[0]?.output(Buffer.from('a\0b\0'));
    children[0]?.exit(0);
    expect(await pending).toEqual({ matches: ['a', 'b'] });
    expect(children[0]?.signals).toEqual([]);
  });
});

describe('expandGlob reports what the spawn reports', () => {
  it.each(['ENOENT', 'ENOTDIR'])('treats %s from the spawn as no match, as a missing working directory has none', async (code) => {
    const { ports, children } = fakePorts();
    const budget = deadlineOf(1_000);
    const pending = expanderWith(ports)('*', '/gone', 10, budget);
    await budget.asked;
    children[0]?.emit('error', Object.assign(new Error(`spawn ${code}`), { code }));
    expect(await pending).toEqual({ matches: [] });
  });

  it('types an unresolvable errno from the spawn', async () => {
    const { ports, children } = fakePorts();
    const budget = deadlineOf(1_000);
    const pending = expanderWith(ports)('*', '/locked', 10, budget);
    await budget.asked;
    children[0]?.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    expect(await pending).toEqual({ unresolvable: { kind: 'errno', code: 'EACCES' } });
  });

  it('rethrows any other error from the spawn unchanged', async () => {
    const { ports, children } = fakePorts();
    const failure = Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' });
    const budget = deadlineOf(1_000);
    const pending = expanderWith(ports)('*', '/', 10, budget);
    await budget.asked;
    children[0]?.emit('error', failure);
    await expect(pending).rejects.toBe(failure);
  });

  it('fails on a non-zero exit with the status and the error text, and does not approve', async () => {
    const { ports, children } = fakePorts();
    const budget = deadlineOf(1_000);
    const pending = expanderWith(ports)('*', '/', 10, budget);
    await budget.asked;
    children[0]?.stderr.emit('data', Buffer.from('boom'));
    children[0]?.exit(2);
    await expect(pending).rejects.toThrow('failed with status 2: boom');
  });

  it('hands the pattern to the shell as one argument and gives it only the locale variables', async () => {
    const { ports, children, spawned } = fakePorts();
    const budget = deadlineOf(1_000);
    const pending = expanderWith(ports)('a b*', '/work', 10, budget);
    await budget.asked;
    children[0]?.exit(0);
    await pending;
    expect(spawned[0]?.file).toBe('/bin/bash');
    expect(spawned[0]?.args.at(-1)).toBe('a b*');
    expect(spawned[0]?.options.cwd).toBe('/work');
    expect(Object.keys(spawned[0]?.options.env ?? {}).every((name) => ['LANG', 'LC_ALL', 'LC_COLLATE', 'LC_CTYPE'].includes(name))).toBe(true);
  });
});

describe('descriptor exhaustion and oversized words never become an uncaught exception', () => {
  const uncaught: Error[] = [];
  const record = (error: Error): void => void uncaught.push(error);

  it.each(['EMFILE', 'ENFILE'])('rejects with %s, unchanged, when the spawn returns a child without streams that reports the error on the next tick', async (code) => {
    uncaught.length = 0;
    process.on('uncaughtException', record);
    try {
      const { ports, timers } = fakePorts();
      const child = new StreamlessChild();
      const failure = Object.assign(new Error(`spawn /bin/bash ${code}`), { code });
      const withoutStreams: ChildPorts = { ...ports, spawn: () => child as unknown as PortChild };
      const budget = deadlineOf(1_000);
      const pending = expanderWith(withoutStreams)('*', '/', 10, budget);
      await budget.asked;
      process.nextTick(() => child.emit('error', failure));
      await expect(pending).rejects.toBe(failure);
      await new Promise((resolve) => setImmediate(resolve));
      expect(uncaught).toEqual([]);
      expect(timers[0]?.cleared).toBe(true);
      expect(child.signals).toEqual(['SIGKILL']);
    } finally {
      process.off('uncaughtException', record);
    }
  });

  it('answers dynamic when the deadline passes for a child without streams', async () => {
    const { ports, timers } = fakePorts();
    const child = new StreamlessChild();
    const budget = deadlineOf(50);
    const pending = expanderWith({ ...ports, spawn: () => child as unknown as PortChild })('*', '/', 10, budget);
    await budget.asked;
    timers[0]?.callback();
    expect(await pending).toEqual(DYNAMIC);
  });

  it('answers dynamic when the spawn throws E2BIG for a word that is too long', async () => {
    const { ports } = fakePorts();
    const tooLong: ChildPorts = {
      ...ports,
      spawn: () => {
        throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' });
      },
    };
    expect(await expanderWith(tooLong)('x*', '/', 10, deadlineOf(1_000))).toEqual(DYNAMIC);
  });

  it('rethrows any other error the spawn throws', async () => {
    const { ports } = fakePorts();
    const failure = Object.assign(new Error('spawn EPERM'), { code: 'EPERM' });
    const broken: ChildPorts = {
      ...ports,
      spawn: () => {
        throw failure;
      },
    };
    await expect(expanderWith(broken)('x*', '/', 10, deadlineOf(1_000))).rejects.toBe(failure);
  });
});

describe('a cancel interrupts the expansion', () => {
  it('spawns nothing when the signal is already aborted', async () => {
    const { ports, spawned } = fakePorts();
    const controller = new AbortController();
    controller.abort();
    expect(await expanderWith(ports, controller.signal)('*', '/', 10, deadlineOf(1_000))).toEqual(DYNAMIC);
    expect(spawned).toEqual([]);
  });

  it('kills the child, clears the timer and answers dynamic at once when the signal aborts, without waiting for the child', async () => {
    const { ports, children, timers } = fakePorts();
    const controller = new AbortController();
    const budget = deadlineOf(60_000);
    const pending = expanderWith(ports, controller.signal)('*', '/', 10, budget);
    await budget.asked;
    controller.abort();
    expect(await pending).toEqual(DYNAMIC);
    expect(children[0]?.signals).toEqual(['SIGKILL']);
    expect(children[0]?.unrefs).toBe(1);
    expect(timers[0]?.cleared).toBe(true);
  });

  it('stops expanding the later words of a decision once the signal has aborted', async () => {
    const { ports, children, spawned, firstSpawn } = fakePorts();
    const controller = new AbortController();
    const host = createPolicyFilesystem('linux', SHELLS, ports);
    const pending = prepareGlobs({
      expand: host.expandGlob,
      platform: 'darwin',
      subject: { kind: 'command', tool: 'Bash', command: 'cat a* b* c*' },
      cwd: '/work',
      home: '/home/user',
      deadline: deadlineOf(60_000),
      signal: controller.signal,
    });
    await firstSpawn;
    controller.abort();
    await pending;
    expect(children).toHaveLength(1);
    expect(spawned).toHaveLength(1);
  });
});

describe('glob matches keep the bytes bash returned (HIGH-3, review item 10)', () => {
  const expandBytes = async (...chunks: Buffer[]) => {
    const { ports, children } = fakePorts();
    const budget = deadlineOf(1_000);
    const pending = expanderWith(ports)('*', '/', 10, budget);
    await budget.asked;
    children[0]?.output(...chunks);
    children[0]?.exit(0);
    return pending;
  };

  it('is dynamic when a name does not round-trip through UTF-8', async () => {
    expect(await expandBytes(Buffer.from([0x6c, 0xff, 0x00]))).toEqual(DYNAMIC);
  });

  it('is dynamic when one name of several does not round-trip', async () => {
    expect(await expandBytes(Buffer.concat([Buffer.from('ok\0'), Buffer.from([0x6c, 0xff, 0x00])]))).toEqual(DYNAMIC);
  });

  it('keeps valid UTF-8 names', async () => {
    expect(await expandBytes(Buffer.from('é.txt\0'))).toEqual({ matches: ['é.txt'] });
  });
});

describe('a real shell through the real spawn', () => {
  it('expands a pattern', async () => {
    const workspace = makeRealWorkspace();
    workspace.write('keep', '');
    expect(await createPolicyFilesystem().expandGlob('k*', workspace.project, 10, deadlineOf(60_000), NEVER_ABORTED)).toEqual({ matches: ['keep'] });
  });
});
