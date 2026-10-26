import { describe, expect, it, vi } from 'vitest';

const spawnCalls = vi.hoisted(() => ({ count: 0 }));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawn: () => {
      spawnCalls.count += 1;
      throw new Error('spawn was reached');
    },
  };
});

const { spawnTracked, startDaemonBin } = await import('@momonga/testkit');

const MISSING_CONTEXT = /test context/i;

describe('process helpers without a usable test context', () => {
  it.for([
    ['an undefined context', undefined],
    ['a context without onTestFinished', {}],
  ] as const)('spawnTracked refuses %s before spawning anything', ([, missing]) => {
    spawnCalls.count = 0;
    expect(() => spawnTracked(missing as never, process.execPath, ['-e', ''])).toThrow(MISSING_CONTEXT);
    expect(spawnCalls.count).toBe(0);
  });

  it('startDaemonBin refuses an undefined context before spawning anything', () => {
    spawnCalls.count = 0;
    expect(() => startDaemonBin(undefined, '/nonexistent/bin.js', [], {})).toThrow(MISSING_CONTEXT);
    expect(spawnCalls.count).toBe(0);
  });
});
