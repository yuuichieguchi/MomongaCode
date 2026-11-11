import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { waitFor } from '@momonga/testkit';
import type { Sandbox, SandboxExit } from '@momonga/sandbox';
import type { RipgrepLocator, ToolLimits } from '@momonga/tools';
import type { ChildPorts } from '../../src/ports.ts';
import { makeBuiltins, resultOf } from './fixtures.ts';

type Armed = { callback: () => void; ms: number };

const fakeTimers = (): { port: ChildPorts; armed: Map<number, Armed>; fire(ms: number): void } => {
  const armed = new Map<number, Armed>();
  let next = 0;
  return {
    armed,
    port: {
      spawn: () => {
        throw new Error('this test starts no process through the child port');
      },
      setTimeout: (callback, ms) => {
        next += 1;
        armed.set(next, { callback, ms });
        return next;
      },
      clearTimeout: (handle) => void armed.delete(handle as number),
    },
    fire: (ms) => {
      for (const [handle, timer] of [...armed]) {
        if (timer.ms !== ms) continue;
        armed.delete(handle);
        timer.callback();
      }
    },
  };
};

const SEARCH_MS = 7_000;

const LIMITS: ToolLimits = {
  bash: { defaultTimeoutMs: 120_000, maxTimeoutMs: 600_000, onTimeout: 'background', backgroundTimeoutMs: 1_800_000, maxBackgroundTimeoutMs: 7_200_000 },
  search: { timeoutMs: SEARCH_MS },
  operations: { timeoutMs: 120_000 },
};

const PARTIAL_NOTE = `Search stopped after ${SEARCH_MS} ms; the matches above are partial. Try a narrower path or pattern.`;

const fakeRipgrep: RipgrepLocator = { locate: async () => ({ ok: true, path: '/fake/rg', source: 'system', version: '14.1.1', release: async () => undefined }) };

const once = (text: string): AsyncIterable<Uint8Array> => ({
  [Symbol.asyncIterator]: () => {
    let sent = false;
    return {
      next: async () => {
        if (sent) return { done: true, value: undefined };
        sent = true;
        return { done: false, value: Buffer.from(text) };
      },
    };
  },
});

const slowSearch = (records: string): { sandbox: Sandbox; searching: () => boolean } => {
  let searching = false;
  const sandbox: Sandbox = {
    kind: 'none',
    spawn: (_command, _policy, signal) => {
      searching = true;
      let pending: (() => void) | undefined;
      const stdout: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]: () => {
          let sent = false;
          return {
            next: async () => {
              if (!sent) {
                sent = true;
                return { done: false, value: Buffer.from(records) };
              }
              if (!signal.aborted) await new Promise<void>((resolve) => {
                pending = resolve;
              });
              return { done: true, value: undefined };
            },
          };
        },
      };
      const exited = new Promise<SandboxExit>((resolve) => {
        const stop = (): void => {
          pending?.();
          resolve({ code: null, signal: 'SIGTERM', killedBy: 'abort' });
        };
        if (signal.aborted) stop();
        else signal.addEventListener('abort', stop, { once: true });
      });
      return { pid: 999_983, pgid: 999_983, stdout, stderr: once(''), exited, rebind: () => undefined };
    },
  };
  return { sandbox, searching: () => searching };
};

describe('a search that reaches tools.search.timeoutMs keeps the matches so far', () => {
  it('Grep returns the matches received before the limit with the note', async () => {
    const timers = fakeTimers();
    const tools = await makeBuiltins({ executor: { shellHost: { platform: process.platform, isExecutable: () => true, child: timers.port } } });
    const first = tools.write('src/first.ts', 'needle\n');
    const second = tools.write('src/second.ts', 'needle\n');
    const live = slowSearch(`${first}\0${second}\0`);
    const running = tools.run('Grep', { pattern: 'needle' }, { limits: LIMITS, sandbox: live.sandbox, ripgrep: fakeRipgrep });
    await waitFor(live.searching, { description: 'the search started' });
    await waitFor(() => [...timers.armed.values()].some((timer) => timer.ms === SEARCH_MS), { description: 'the search limit is armed' });
    timers.fire(SEARCH_MS);
    const result = resultOf(await running);
    expect(result.status).toBe('completed');
    expect(result.output).toContain('first.ts');
    expect(result.output).toContain('second.ts');
    expect(result.output).toContain(PARTIAL_NOTE);
  });

  it('Glob returns the entries found before the limit with the note', async () => {
    const timers = fakeTimers();
    let stalled = false;
    const stalling: FileSystem = {
      ...nodeFileSystem,
      readdirEntries: (directory) => {
        if (path.basename(directory) !== 'stalled') return nodeFileSystem.readdirEntries(directory);
        stalled = true;
        return new Promise(() => undefined);
      },
    };
    const tools = await makeBuiltins({ executor: { files: stalling, shellHost: { platform: process.platform, isExecutable: () => true, child: timers.port } } });
    tools.write('a/found.ts', 'x\n');
    tools.write('stalled/hidden.ts', 'x\n');
    const running = tools.run('Glob', { pattern: '**/*.ts' }, { limits: LIMITS });
    await waitFor(() => stalled, { description: 'the walk reached the stalled directory' });
    timers.fire(SEARCH_MS);
    const result = resultOf(await running);
    expect(result.status).toBe('completed');
    expect(result.output).toContain('found.ts');
    expect(result.output).not.toContain('hidden.ts');
    expect(result.output).toContain(`Search stopped after ${SEARCH_MS} ms; the entries above are partial. Try a narrower path or pattern.`);
  });
});
