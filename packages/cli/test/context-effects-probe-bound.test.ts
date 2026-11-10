import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_READ_BOUND_MS, OperationLimitError, STARTUP_TIMEOUT_MS, momongaPaths } from '@momonga/foundation';
import type { HostExec } from '@momonga/foundation';
import { nodeContextEffects } from '../src/eval/context-effects.ts';
import { nodeFiles } from '../src/node-ports.ts';
import type { CliPorts } from '../src/ports.ts';
import { LIMIT_TIMERS, MANAGED_CLASSIFIER, homeWithAManagedModel, isSettled, outcomeOf, untilTheExecIsAsked } from './unanswered-host-exec.ts';

const unanswered = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('@momonga/foundation', async (importOriginal) => {
  const original = await importOriginal<typeof import('@momonga/foundation')>();
  const neverAnswers: HostExec = (file) =>
    new Promise(() => {
      unanswered.calls.push(file);
    });
  return { ...original, createHostExec: () => neverAnswers };
});

const homes: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  unanswered.calls.length = 0;
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const copyUnder = (signal: AbortSignal): Promise<void> => {
  const { home, binary } = homeWithAManagedModel();
  homes.push(home);
  const effects = nodeContextEffects({ platform: 'darwin', env: {}, home, files: nodeFiles, interrupt: new AbortController().signal } as unknown as CliPorts);
  const caseHome = path.join(home, 'case');
  fs.mkdirSync(caseHome);
  return effects.copyProbeRecord({ model: MANAGED_CLASSIFIER, server: 'fm', binary, upstream: 'system' }, momongaPaths(caseHome, 'darwin', {}), signal);
};

describe('the probe key read of a copied probe record is bounded by the command, with the one host read bound', () => {
  it('is still pending after the start bound of the processes and ends at the host read bound', async () => {
    vi.useFakeTimers({ toFake: [...LIMIT_TIMERS] });
    const outcome = outcomeOf(copyUnder(new AbortController().signal));
    await untilTheExecIsAsked(unanswered.calls, 1);

    await vi.advanceTimersByTimeAsync(STARTUP_TIMEOUT_MS);
    expect(await isSettled(outcome)).toBe(false);
    await vi.advanceTimersByTimeAsync(HOST_READ_BOUND_MS - STARTUP_TIMEOUT_MS - 1);
    expect(await isSettled(outcome)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const ended = await outcome;
    expect(ended).toEqual({ error: expect.any(OperationLimitError) });
    expect(ended).toMatchObject({ error: { limitMs: HOST_READ_BOUND_MS } });
  });

  it('ends at once with the reason of the command when the command is stopped', async () => {
    const command = new AbortController();
    const stopped = new Error('the person stopped the command');
    const outcome = outcomeOf(copyUnder(command.signal));
    await untilTheExecIsAsked(unanswered.calls, 1);

    command.abort(stopped);

    expect(await outcome).toEqual({ error: stopped });
  });
});
