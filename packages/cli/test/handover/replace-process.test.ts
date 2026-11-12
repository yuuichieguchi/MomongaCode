import { spawn } from '@momonga/testkit/child-process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { replaceProcess } from '../../src/handover/replace-process.ts';
import type { RelayChild, ReplaceHost, ReplaceTarget } from '../../src/handover/replace-process.ts';
import { createTempDir } from '@momonga/testkit';

const TARGET: ReplaceTarget = { file: '/opt/momonga', args: ['--resume', 'abc', '--handover', '/run/handover/s.json'], env: { PATH: '/usr/bin:/bin', MOMONGA_HANDOVER_TERMINAL: '{}' } };

type FakeChild = RelayChild & EventEmitter & { signals: NodeJS.Signals[] };

const relayHost = (log: string[]) => {
  const child: FakeChild = Object.assign(new EventEmitter(), {
    pid: 4242,
    signals: [] as NodeJS.Signals[],
    kill: (signal: NodeJS.Signals) => {
      child.signals.push(signal);
      return true;
    },
  });
  const signalListeners = new Map<string, () => void>();
  const exits: number[] = [];
  const spawned: { file: string; args: readonly string[]; stdio: unknown; env: unknown }[] = [];
  const host: ReplaceHost = {
    execve: undefined,
    spawn: (file, args, options) => {
      log.push('spawn');
      spawned.push({ file, args, stdio: options.stdio, env: options.env });
      return child;
    },
    exit: (code) => {
      exits.push(code);
    },
    flush: async () => undefined,
    onSignal: (signal, listener) => {
      signalListeners.set(signal, listener);
    },
  };
  return { host, child, exits, spawned, signalListeners };
};

describe('the handover replaces the process in place where the host reports execve (16.7, 16.14)', () => {
  it('calls execve with the target file as argv[0] followed by the arguments and the environment, and starts no child', async () => {
    const calls: unknown[] = [];
    const log: string[] = [];
    const { host, spawned } = relayHost(log);
    const replaced = replaceProcess(TARGET, {
      ...host,
      execve: (file, args, env) => {
        calls.push({ file, args, env });
        throw new Error('execve returned control');
      },
    }, { release: () => log.push('release'), relayed: () => undefined });
    await expect(replaced).rejects.toThrow('execve returned control');
    expect(calls).toEqual([{ file: '/opt/momonga', args: ['/opt/momonga', ...TARGET.args], env: TARGET.env }]);
    expect(spawned).toEqual([]);
    expect(log).toEqual([]);
  });
});

describe('the relay, where the host has no execve (red tests 2 and 14, O5)', () => {
  it('releases the input before the child is spawned, with inherited stdio and the environment of the target', async () => {
    const log: string[] = [];
    const { host, spawned } = relayHost(log);
    void replaceProcess(TARGET, host, { release: () => log.push('release'), relayed: () => undefined });
    await Promise.resolve();
    expect(log).toEqual(['release', 'spawn']);
    expect(spawned).toEqual([{ file: '/opt/momonga', args: TARGET.args, stdio: 'inherit', env: TARGET.env }]);
  });

  it('exits with the status of the child', async () => {
    const { host, child, exits } = relayHost([]);
    const relayed = replaceProcess(TARGET, host, { release: () => undefined, relayed: () => undefined });
    child.emit('spawn');
    child.emit('exit', 7, null);
    expect(await relayed).toBe('relayed');
    expect(exits).toEqual([7]);
  });

  it('exits with 128 plus the signal number when a signal ended the child', async () => {
    const { host, child, exits } = relayHost([]);
    const relayed = replaceProcess(TARGET, host, { release: () => undefined, relayed: () => undefined });
    child.emit('spawn');
    child.emit('exit', null, 'SIGTERM');
    await relayed;
    expect(exits).toEqual([143]);
  });

  it('forwards SIGTERM and SIGHUP sent to its own pid to the child', async () => {
    const { host, child, signalListeners } = relayHost([]);
    void replaceProcess(TARGET, host, { release: () => undefined, relayed: () => undefined });
    child.emit('spawn');
    signalListeners.get('SIGTERM')?.();
    signalListeners.get('SIGHUP')?.();
    expect(child.signals).toEqual(['SIGTERM', 'SIGHUP']);
  });

  it('names the child to its hooks once it is spawned, and not before', async () => {
    const log: string[] = [];
    const { host, child } = relayHost(log);
    void replaceProcess(TARGET, host, { release: () => log.push('release'), relayed: (pid) => log.push(`relayed ${pid}`) });
    await Promise.resolve();
    expect(log).toEqual(['release', 'spawn']);
    child.emit('spawn');
    expect(log).toEqual(['release', 'spawn', 'relayed 4242']);
  });

  it('ends the child and fails when the hooks cannot name it', async () => {
    const { host, child, exits } = relayHost([]);
    const relayed = replaceProcess(TARGET, host, {
      release: () => undefined,
      relayed: () => {
        throw new Error('EACCES: the record cannot be written');
      },
    });
    child.emit('spawn');
    await expect(relayed).rejects.toThrow('EACCES');
    expect(child.signals).toEqual(['SIGTERM']);
    expect(exits).toEqual([]);
  });

  it('fails, and exits nothing, when the child cannot be started', async () => {
    const { host, child, exits } = relayHost([]);
    const relayed = replaceProcess(TARGET, host, { release: () => undefined, relayed: () => undefined });
    child.emit('error', new Error('spawn /opt/momonga ENOENT'));
    await expect(relayed).rejects.toThrow('ENOENT');
    expect(exits).toEqual([]);
  });
});

const FIXTURE = fileURLToPath(new URL('../fixtures/relay-child.mjs', import.meta.url));

const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

const realRelay = (code: number) => {
  const folder = createTempDir();
  folders.push(folder);
  const released = path.join(folder, 'released');
  const exits: number[] = [];
  const listeners = new Map<string, () => void>();
  let spawned: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    spawned = resolve;
  });
  const host: ReplaceHost = {
    execve: undefined,
    spawn: (file, args, options) => {
      const child = spawn(file, args, options);
      child.once('spawn', () => spawned());
      return child;
    },
    exit: (exitCode) => {
      exits.push(exitCode);
    },
    flush: async () => undefined,
    onSignal: (signal, listener) => {
      listeners.set(signal, listener);
    },
  };
  const target: ReplaceTarget = { file: process.execPath, args: [FIXTURE, released, String(code)], env: { ...process.env } };
  const relayed = replaceProcess(target, host, { release: () => fs.writeFileSync(released, ''), relayed: () => undefined });
  return { relayed, exits, listeners, started };
};

describe('the relay with a real child process', () => {
  it('releases the input before the child starts, and exits with the status of the child', async () => {
    const { relayed, exits } = realRelay(7);
    expect(await relayed).toBe('relayed');
    expect(exits).toEqual([7]);
  });

  it('forwards a signal sent to the relay to the child, and exits with 128 plus its number', async () => {
    const { relayed, exits, listeners, started } = realRelay(0);
    await started;
    listeners.get('SIGTERM')?.();
    await relayed;
    expect(exits).toEqual([128 + os.constants.signals.SIGTERM]);
  });
});
