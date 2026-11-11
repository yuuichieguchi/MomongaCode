import { describe, expect, it } from 'vitest';
import type { Sandbox } from '@momonga/sandbox';
import { grepTool } from '../src/builtins/grep.ts';
import type { RipgrepLocator } from '../src/ripgrep-locator.ts';
import { call, makeTool, toolSetOf } from './harness.ts';
import { keyFor } from './helpers.ts';
import { LEAVER_PGID, leaver, resultOf, runOne, world } from './guard-world.ts';

const SEARCH_GROUP = 999_993;
const SETTLED_PREFIX = (name: string) => `Not run: a process started by an earlier command (marker ${name}, unidentified) may still be running and could not be stopped. `;

const fakeRipgrep: RipgrepLocator = { locate: async () => ({ ok: true, path: '/fake/rg', source: 'path', version: '15.2.0', release: async () => undefined }) };

const empty = async function* (): AsyncGenerator<Uint8Array> {};

const noMatchSandbox: Sandbox = {
  kind: 'none',
  spawn: () => ({ pid: SEARCH_GROUP, pgid: SEARCH_GROUP, stdout: empty(), stderr: empty(), exited: Promise.resolve({ code: 1, signal: null, stop: 'confirmed' }) }),
};

const runner = makeTool('Runner', { sideEffect: 'exec', subjectKind: 'none', execute: async () => ({ status: 'completed', output: 'ran' }) });

const extra = { sandbox: noMatchSandbox, ripgrep: fakeRipgrep };

const runGrep = async (h: ReturnType<typeof world>, callId: string) => {
  const [outcome] = await h.harness.executor.runBatch(await h.harness.input(await toolSetOf(leaver, grepTool), [call(callId, 'Grep', { pattern: 'needle' }, 'allow_once')], extra));
  return outcome;
};

describe('the guard runs before every call whose tool starts processes, Grep included', () => {
  it('refuses a Grep call with the same verdict and wording as an exec call while a process of an earlier command can still run', async () => {
    const name = keyFor('run-1', 1, 'first');
    const execWorld = world('held', {}, new Set([LEAVER_PGID]));
    await runOne(execWorld, 'Leaver', 'first');
    const execRefusal = resultOf(await runOne(execWorld, 'Runner', 'second', [runner], extra));

    const grepWorld = world('held', {}, new Set([LEAVER_PGID]));
    await runOne(grepWorld, 'Leaver', 'first');
    const grepRefusal = resultOf(await runGrep(grepWorld, 'second'));

    expect(execRefusal.status).toBe('failed');
    expect(execRefusal.output.startsWith(SETTLED_PREFIX(name))).toBe(true);
    expect(grepRefusal).toEqual(execRefusal);
  });

  it('runs the Grep call when the earlier marker is free', async () => {
    const h = world('free', {}, new Set());
    await runOne(h, 'Leaver', 'first');
    expect(resultOf(await runGrep(h, 'second'))).toMatchObject({ status: 'completed', output: 'No matches found' });
  });
});
