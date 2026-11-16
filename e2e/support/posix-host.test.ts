import { describe, expect, it } from 'vitest';
import { requirePosixHost } from './posix-host.ts';

describe('the POSIX helpers of the e2e project', () => {
  it('name themselves and the platform when started on Windows', () => {
    expect(() => requirePosixHost('the pty helper', 'win32')).toThrow('the pty helper runs on macOS and Linux only; this host is win32');
  });

  it('start on macOS and Linux', () => {
    expect(() => requirePosixHost('the stack helper', 'darwin')).not.toThrow();
    expect(() => requirePosixHost('the stack helper', 'linux')).not.toThrow();
  });
});
