import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { replaceProcess } from '../../src/handover/replace-process.ts';
import type { RelayChild, ReplaceHost, ReplaceTarget } from '../../src/handover/replace-process.ts';

const TARGET: ReplaceTarget = { file: '/opt/momonga', args: ['--resume', 'abc', '--handover', '/run/handover/s.json'], env: { PATH: '/usr/bin:/bin', MOMONGA_HANDOVER_TERMINAL: '{}' } };

type FakeChild = RelayChild & EventEmitter & { signals: NodeJS.Signals[] };

const relayHost = (log: string[]) => {
  const child: FakeChild = Object.assign(new EventEmitter(), {
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
    }, { release: () => log.push('release') });
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
    void replaceProcess(TARGET, host, { release: () => log.push('release') });
    await Promise.resolve();
    expect(log).toEqual(['release', 'spawn']);
    expect(spawned).toEqual([{ file: '/opt/momonga', args: TARGET.args, stdio: 'inherit', env: TARGET.env }]);
  });

  it('exits with the status of the child', async () => {
    const { host, child, exits } = relayHost([]);
    const relayed = replaceProcess(TARGET, host, { release: () => undefined });
    child.emit('spawn');
    child.emit('exit', 7, null);
    expect(await relayed).toBe('relayed');
    expect(exits).toEqual([7]);
  });

  it('exits with 128 plus the signal number when a signal ended the child', async () => {
    const { host, child, exits } = relayHost([]);
    const relayed = replaceProcess(TARGET, host, { release: () => undefined });
    child.emit('spawn');
    child.emit('exit', null, 'SIGTERM');
    await relayed;
    expect(exits).toEqual([143]);
  });

  it('forwards SIGTERM and SIGHUP sent to its own pid to the child', async () => {
    const { host, child, signalListeners } = relayHost([]);
    void replaceProcess(TARGET, host, { release: () => undefined });
    child.emit('spawn');
    signalListeners.get('SIGTERM')?.();
    signalListeners.get('SIGHUP')?.();
    expect(child.signals).toEqual(['SIGTERM', 'SIGHUP']);
  });

  it('fails, and exits nothing, when the child cannot be started', async () => {
    const { host, child, exits } = relayHost([]);
    const relayed = replaceProcess(TARGET, host, { release: () => undefined });
    child.emit('error', new Error('spawn /opt/momonga ENOENT'));
    await expect(relayed).rejects.toThrow('ENOENT');
    expect(exits).toEqual([]);
  });
});
