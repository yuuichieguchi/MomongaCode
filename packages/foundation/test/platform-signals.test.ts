import { describe, expect, it } from 'vitest';
import { signalsOf } from '@momonga/foundation';

const UNCATCHABLE: readonly NodeJS.Signals[] = ['SIGKILL', 'SIGSTOP'];

describe('the signals a platform delivers to a process', () => {
  it('names no job-control signal on Windows, where a console delivers only its own events', () => {
    const windows = signalsOf('win32');
    expect(windows).not.toContain('SIGSTOP');
    expect(windows).not.toContain('SIGTSTP');
    expect(windows).not.toContain('SIGCONT');
    expect(windows).toEqual(expect.arrayContaining(['SIGINT', 'SIGHUP', 'SIGBREAK', 'SIGWINCH']));
  });

  it.each(['linux', 'darwin'] as const)('names the job-control and hang-up signals on %s', (platform) => {
    expect(signalsOf(platform)).toEqual(expect.arrayContaining(['SIGSTOP', 'SIGCONT', 'SIGTSTP', 'SIGHUP', 'SIGINT', 'SIGTERM', 'SIGWINCH']));
  });

  it('gives the same list for the same platform', () => {
    expect(signalsOf('linux')).toBe(signalsOf('linux'));
    expect(signalsOf('win32')).toBe(signalsOf('win32'));
  });

  it('lets this host install a handler for every catchable signal its list names', () => {
    const listener = (): undefined => undefined;
    const installed: NodeJS.Signals[] = [];
    try {
      for (const signal of signalsOf(process.platform).filter((name) => !UNCATCHABLE.includes(name))) {
        process.on(signal, listener);
        installed.push(signal);
      }
    } finally {
      for (const signal of installed) process.off(signal, listener);
    }
    expect(installed.length).toBeGreaterThan(0);
  });
});
