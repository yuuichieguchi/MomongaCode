import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { ensureMomongaDirs, momongaPaths, systemClock, systemRandom, systemTiming } from '@momonga/foundation';
import { withTempDir } from '@momonga/testkit';
import { describe, expect, it, vi } from 'vitest';
import type { TestContext } from 'vitest';
import { SessionUpdatedError } from '../../src/daemon/ensure-daemon.ts';
import type { Mover } from '../../src/handover/mover.ts';
import type { CliPorts, Terminal } from '../../src/ports.ts';
import type { TuiBackend } from '../../src/tui/backend.ts';
import type { NoticeSource } from '../../src/tui/notices.ts';
import { runInteractive } from '../../src/tui/run-interactive.tsx';
import type { ShellPort } from '../../src/tui/slash.ts';
import type { UpdateWiring } from '../../src/update/background.ts';
import { fakeBackend } from '../fake-backend.ts';
import { setupUpdate } from '../update-harness.ts';

const backendControl = vi.hoisted(() => ({
  next: undefined as ((noticeSources: readonly NoticeSource[]) => TuiBackend) | undefined,
}));

vi.mock('ink', async (importOriginal) => {
  const original = await importOriginal<typeof import('ink')>();
  return {
    ...original,
    render: (node: Parameters<typeof original.render>[0], options?: Parameters<typeof original.render>[1]) =>
      original.render(node, typeof options === 'object' && options !== null && !('pipe' in options) ? { ...options, patchConsole: false } : options),
  };
});

vi.mock('../../src/tui/backend.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/tui/backend.ts')>()),
  createTuiBackend: (_ports: CliPorts, _paths: unknown, _options: unknown, _history: unknown, noticeSources: readonly NoticeSource[]) => {
    if (backendControl.next === undefined) throw new Error('missing fake backend factory');
    return backendControl.next(noticeSources);
  },
}));

const DA1_REPLY = Buffer.from('\u001b[?62;c');

const fakeRuntime = {
  skills: async () => ({ warnings: [] }),
  agents: async () => ({ warnings: [] }),
  mcpWarnings: async () => [],
  memories: async () => [],
};

const makeFakeTerminal = (home: string) => {
  const screenFile = path.join(home, 'screen');
  const descriptor = fs.openSync(screenFile, 'w');
  const stdin = Object.assign(new EventEmitter(), {
    setRawMode: (on: boolean) => {
      if (on) queueMicrotask(() => stdin.emit('data', DA1_REPLY));
    },
    resume: () => undefined,
    pause: () => undefined,
  });
  const chunks: string[] = [];
  const stdout = Object.assign(new PassThrough(), {
    fd: descriptor,
    columns: 100,
    rows: 30,
    isTTY: true,
    getColorDepth: () => 1,
  });
  stdout.on('data', (chunk: Buffer) => {
    chunks.push(chunk.toString('utf8'));
  });
  const terminal = {
    stdin,
    stdout,
    colourOff: () => undefined,
  } as unknown as Terminal;
  return {
    terminal,
    send: (text: string) => stdin.emit('data', Buffer.from(text, 'utf8')),
    output: () => chunks.join(''),
    closeDescriptor: () => fs.closeSync(descriptor),
  };
};

const makeShell = (): ShellPort => ({
  run: async () => 0,
});

const makeUpdate = async (context: TestContext, home: string, version = '1.0.0') => {
  const harness = await setupUpdate(context, { version });
  const listeners = new Set<() => void>();
  const wiring: UpdateWiring = {
    ...harness.wiring,
    ports: {
      ...harness.ports,
      home,
      watch: (onChange) => {
        listeners.add(onChange);
        return () => void listeners.delete(onChange);
      },
    },
  };
  return {
    harness,
    wiring,
    emitWatch: () => {
      for (const listener of [...listeners]) listener();
    },
    watchCount: () => listeners.size,
  };
};

const makePorts = (home: string, version: string, handover: CliPorts['handover']): CliPorts =>
  ({
    version,
    home,
    cwd: home,
    env: {},
    platform: process.platform,
    clock: systemClock,
    timers: systemTiming,
    random: systemRandom,
    files: {
      exists: async (file: string) => fs.existsSync(file),
      stat: async (file: string) => fs.promises.stat(file),
      lstat: async (file: string) => fs.promises.lstat(file),
      realpath: async (file: string) => fs.promises.realpath(file),
      readFile: async (file: string) => fs.promises.readFile(file, 'utf8'),
      readText: async (file: string) => fs.promises.readFile(file, 'utf8'),
      writeTextAtomically: async (file: string, text: string) => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, text, 'utf8');
      },
    },
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
    interrupt: new AbortController().signal,
    handover,
  }) as unknown as CliPorts;

describe('runInteractive background update handover wiring', () => {
  it('relaunches directly into the new binary when boot fails with SessionUpdatedError', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, {});
    await ensureMomongaDirs(paths);
    const { terminal, closeDescriptor } = makeFakeTerminal(home);
    const { wiring } = await makeUpdate(context, home);
    let relaunched = 0;
    let closed = 0;
    backendControl.next = () => ({
      ...fakeBackend(),
      boot: async () => {
        throw new SessionUpdatedError('2.0.0', 'momonga was updated to v2.0.0; reopen this session.', paths.logFiles.supervisor);
      },
      close: async () => {
        closed += 1;
      },
    });
    const ports = makePorts(home, '1.0.0', {
      args: [],
      started: undefined,
      mover: { attach: () => () => undefined, learned: async () => undefined, check: async () => undefined, refuse: () => undefined, standing: () => 'cannot-move' },
      removeRecord: () => undefined,
      relaunch: async () => {
        relaunched += 1;
        return 'relayed';
      },
    });

    try {
      const exit = await runInteractive(ports, paths, terminal, {}, wiring, makeShell());
      expect(exit).toBe(0);
      expect(relaunched).toBe(1);
      expect(closed).toBe(1);
    } finally {
      closeDescriptor();
    }
  });

  it('triggers mover.learned automatically when backgroundCheck finishes installing a newer version without any keypress', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, {});
    await ensureMomongaDirs(paths);
    const { terminal, send, output, closeDescriptor } = makeFakeTerminal(home);
    const { harness, wiring, watchCount } = await makeUpdate(context, home);
    const learned: Array<{ version: string; own: string }> = [];
    const bg = Promise.withResolvers<void>();
    const mover: Mover = {
      attach: () => () => undefined,
      learned: async (version, own) => {
        learned.push({ version, own });
      },
      check: async () => undefined,
      refuse: () => undefined,
      standing: () => 'moves-at-quiet-point',
    };
    backendControl.next = (noticeSources) => {
      const base = fakeBackend();
      return {
        ...base,
        startupNotices: async () => (await Promise.all(noticeSources.map((source) => source({ runtime: fakeRuntime as never, session: { cwd: home, model: 'scripted/default', id: 's1' } as never })))).flat(),
      };
    };
    const ports = makePorts(home, '1.0.0', { args: [], started: undefined, mover, removeRecord: () => undefined });

    const running = runInteractive(ports, paths, terminal, { backgroundCheck: { done: bg.promise } }, wiring, makeShell());
    const unexpectedExit = running.then((code) => {
      throw new Error(`runInteractive exited early with code ${code}; output=${JSON.stringify(output())}`);
    });
    try {
      await Promise.race([unexpectedExit, vi.waitFor(() => expect(output()).toContain('mode: manual'), { timeout: 5000 })]);
      expect(watchCount()).toBe(1);

      harness.state.value = { checkedAt: 10, outcome: { kind: 'installed', version: '2.0.0' }, announced: false };
      bg.resolve();
      await Promise.race([unexpectedExit, vi.waitFor(() => expect(learned).toEqual([{ version: '2.0.0', own: 'live' }]), { timeout: 5000 })]);
      expect(harness.state.value).toMatchObject({ announced: false });

      send('\u0004');
      await vi.waitFor(() => expect(output()).toContain('again to exit'), { timeout: 5000 });
      send('\u0004');
      expect(await running).toBe(0);
      expect(watchCount()).toBe(0);
    } finally {
      closeDescriptor();
    }
  });

  it('shows a late failure notice in the TUI when backgroundCheck fails after startupNotices already ran', async (context) => {
    const home = withTempDir(context, { asHome: true });
    const paths = momongaPaths(home, process.platform, {});
    await ensureMomongaDirs(paths);
    const { terminal, send, output, closeDescriptor } = makeFakeTerminal(home);
    const { harness, wiring } = await makeUpdate(context, home);
    const learned: string[] = [];
    const bg = Promise.withResolvers<void>();
    let noticesRan = false;
    const mover: Mover = {
      attach: () => () => undefined,
      learned: async (version) => {
        learned.push(version);
      },
      check: async () => undefined,
      refuse: () => undefined,
      standing: () => 'cannot-move',
    };
    backendControl.next = (noticeSources) => {
      const base = fakeBackend();
      return {
        ...base,
        startupNotices: async () => {
          const found = (await Promise.all(noticeSources.map((source) => source({ runtime: fakeRuntime as never, session: { cwd: home, model: 'scripted/default', id: 's1' } as never })))).flat();
          noticesRan = true;
          return found;
        },
      };
    };
    const ports = makePorts(home, '1.0.0', { args: [], started: undefined, mover, removeRecord: () => undefined });

    const running = runInteractive(ports, paths, terminal, { backgroundCheck: { done: bg.promise } }, wiring, makeShell());
    const unexpectedExit = running.then((code) => {
      throw new Error(`runInteractive exited early with code ${code}; output=${JSON.stringify(output())}`);
    });
    try {
      await Promise.race([unexpectedExit, vi.waitFor(() => expect(noticesRan).toBe(true), { timeout: 5000 })]);

      harness.state.value = { checkedAt: 10, outcome: { kind: 'failed', code: 'checksum_mismatch', message: 'bad hash' }, announced: false };
      bg.resolve();
      await Promise.race([unexpectedExit, vi.waitFor(() => expect(output()).toContain('checksum_mismatch'), { timeout: 5000 })]);
      expect(learned).toEqual([]);
      expect(harness.state.value).toMatchObject({ announced: true });

      send('\u0004');
      await vi.waitFor(() => expect(output()).toContain('again to exit'), { timeout: 5000 });
      send('\u0004');
      expect(await running).toBe(0);
    } finally {
      closeDescriptor();
    }
  });
});
