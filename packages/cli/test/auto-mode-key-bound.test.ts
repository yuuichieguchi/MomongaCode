import fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_READ_BOUND_MS, OperationLimitError, STARTUP_TIMEOUT_MS } from '@momonga/foundation';
import type { HostExec } from '@momonga/foundation';
import { autoModeStatus } from '../src/commands/auto-mode.ts';
import type { AutoModeStatusPorts } from '../src/commands/auto-mode.ts';
import { LIMIT_TIMERS, MANAGED_CLASSIFIER, homeWithAManagedModel, isSettled, outcomeOf, untilTheExecIsAsked } from './unanswered-host-exec.ts';
import { userModelsOf } from './user-models.ts';

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

const statusPorts = (): AutoModeStatusPorts => {
  const { home, models } = homeWithAManagedModel();
  homes.push(home);
  return { models: userModelsOf(models), configuredClassifier: MANAGED_CLASSIFIER, home, platform: 'darwin', write: () => undefined };
};

describe('the classifier key read of auto-mode status is bounded by the command, with the one host read bound', () => {
  it('is still pending after the start bound of the processes and ends at the host read bound', async () => {
    vi.useFakeTimers({ toFake: [...LIMIT_TIMERS] });
    const outcome = outcomeOf(autoModeStatus(statusPorts(), { surface: 'cli', signal: new AbortController().signal }));
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
    const outcome = outcomeOf(autoModeStatus(statusPorts(), { surface: 'cli', signal: command.signal }));
    await untilTheExecIsAsked(unanswered.calls, 1);

    command.abort(stopped);

    expect(await outcome).toEqual({ error: stopped });
  });

  it('leaves no timer behind once the read has ended', async () => {
    vi.useFakeTimers({ toFake: [...LIMIT_TIMERS] });
    const command = new AbortController();
    const outcome = outcomeOf(autoModeStatus(statusPorts(), { surface: 'cli', signal: command.signal }));
    await untilTheExecIsAsked(unanswered.calls, 1);
    expect(vi.getTimerCount()).toBe(1);

    command.abort(new Error('stopped'));
    await outcome;

    expect(vi.getTimerCount()).toBe(0);
  });
});
