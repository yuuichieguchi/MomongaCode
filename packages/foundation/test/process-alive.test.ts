import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { isProcessAlive, linuxRunStateOf } from '../src/process-alive.ts';

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

  it('the linux reader reports an absent process as undefined', () => {
    const read = (): string => {
      throw Object.assign(new Error('no'), { code: 'ENOENT' });
    };
    expect(linuxRunStateOf(read)(42)).toBeUndefined();
  });

  it('a host child that has exited but is not yet waited for is not alive', async () => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid as number;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const deadline = Date.now() + 5000;
    while (isProcessAlive(pid) && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
    expect(isProcessAlive(pid)).toBe(false);
    await exited;
  });
});
