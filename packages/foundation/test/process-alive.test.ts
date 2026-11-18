import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isProcessAlive, linuxRunStateOf, runStateOfHost } from '../src/process-alive.ts';

const delivered = (): void => undefined;

describe('isProcessAlive', () => {
  it('a process whose run state is past running (a zombie) has ended', () => {
    expect(isProcessAlive(42, delivered, () => 'Z')).toBe(false);
    expect(isProcessAlive(42, delivered, () => 'X')).toBe(false);
  });

  it('a process that is still running or sleeping is alive', () => {
    expect(isProcessAlive(42, delivered, () => 'S')).toBe(true);
    expect(isProcessAlive(42, delivered, () => 'R+')).toBe(true);
  });

  it('a process whose state has disappeared between the signal and the read has ended', () => {
    expect(isProcessAlive(42, delivered, () => undefined)).toBe(false);
  });

  it('the state reader is not consulted when the signal finds no process', () => {
    const missing = (): void => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    };
    expect(isProcessAlive(42, missing, () => 'S')).toBe(false);
  });

  it('the linux reader takes the state after the command name, whatever the name holds', () => {
    const read = (): string => '42 (a) b) Z 1 42 42 0 -1';
    expect(linuxRunStateOf(read)(42)).toBe('Z');
  });

  it('a process whose state cannot be read is left as the signal answered: alive', () => {
    const denied = (): string => {
      throw Object.assign(new Error('no'), { code: 'EACCES' });
    };
    expect(isProcessAlive(42, delivered, linuxRunStateOf(denied))).toBe(true);
  });

  it('the linux reader reports an absent process as undefined', () => {
    const read = (): string => {
      throw Object.assign(new Error('no'), { code: 'ENOENT' });
    };
    expect(linuxRunStateOf(read)(42)).toBeUndefined();
  });

  it('a host child is alive until it exits and is not alive once its exit is reported', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const pid = child.pid as number;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    expect(isProcessAlive(pid)).toBe(true);
    child.stdin.end();
    await exited;
    expect(isProcessAlive(pid)).toBe(false);
  });
});

describe('runStateOfHost: the run state is read where the host reports it, never chosen by the platform name (B1)', () => {
  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

  it('reads /proc when the host serves its own /proc/self/stat', () => {
    const asked: string[] = [];
    const stateOf = runStateOfHost((file) => {
      asked.push(file);
      return '42 (node) Z 1 2 3';
    });
    expect(asked).toEqual(['/proc/self/stat']);
    expect(stateOf?.(42)).toBe('Z');
  });

  it.each([['ENOENT'], ['ENOTDIR']])('has no run-state reader when /proc/self/stat is absent (%s)', (code) => {
    expect(
      runStateOfHost(() => {
        throw errno(code);
      }),
    ).toBeNull();
  });

  it('lets any other failure of the probe propagate rather than guessing', () => {
    expect(() =>
      runStateOfHost(() => {
        throw errno('EIO');
      }),
    ).toThrow('EIO');
  });
});
