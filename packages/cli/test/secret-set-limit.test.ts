import { OperationLimitError, StoreCallEndedError, momongaLayout } from '@momonga/foundation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { secretSet } from '../src/commands/secret.ts';
import { describeFailure } from '../src/failure.ts';
import { KEYCHAIN_UNANSWERED_ADVICE, afterPendingIo, keychainFixture, outcomeOf, secretSetPorts, useLimitTimers } from './keychain-fixture.ts';

const COMMAND_LIMIT_MS = 300_000;

const released: AbortController[] = [];

const interruptOf = (): AbortController => {
  const controller = new AbortController();
  released.push(controller);
  return controller;
};

afterEach(() => {
  for (const controller of released.splice(0)) controller.abort(new Error('the test ended'));
  vi.useRealTimers();
});

describe('momonga secret set against a secret store that does not answer', () => {
  it('a hung write ends at the command limit', async () => {
    useLimitTimers();
    const keychain = keychainFixture({ control: { calls: 'hang' } });
    const { ports, stdout } = secretSetPorts(keychain.store, 'v\rv\r');

    const attempt = outcomeOf(secretSet(ports, momongaLayout('/home/u'), 'k', interruptOf().signal));
    await keychain.arrived('add-generic-password');
    await vi.advanceTimersByTimeAsync(COMMAND_LIMIT_MS - 1);
    await afterPendingIo();
    expect(attempt.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await afterPendingIo();

    expect(attempt.state()).toBe('rejected');
    expect(attempt.error()).toBeInstanceOf(StoreCallEndedError);
    expect(`momonga: ${describeFailure(attempt.error())}\n`).toBe(
      `momonga: the write of the secret "k" did not finish within the command limit of 300000 ms; ${KEYCHAIN_UNANSWERED_ADVICE}; run the command again\n`,
    );
    expect(stdout).toEqual([]);
    expect(keychain.port.ended.map((ended) => ended.args)).toEqual([['-i']]);
    expect(keychain.port.ended[0]?.reason).toBeInstanceOf(OperationLimitError);
  });

  it("the read-back shares the command's limit", async () => {
    useLimitTimers();
    const WRITE_ANSWERS_AFTER_MS = 100_000;
    const writeAnswer = Promise.withResolvers<void>();
    const keychain = keychainFixture({
      beforeAnswer: async (command) => {
        if (command === 'add-generic-password') await writeAnswer.promise;
        if (command === 'find-generic-password') keychain.control.calls = 'hang';
      },
    });
    const { ports, stdout } = secretSetPorts(keychain.store, 'v\rv\r');

    const attempt = outcomeOf(secretSet(ports, momongaLayout('/home/u'), 'k', interruptOf().signal));
    await keychain.arrived('add-generic-password');
    await vi.advanceTimersByTimeAsync(WRITE_ANSWERS_AFTER_MS);
    writeAnswer.resolve();
    await keychain.arrived('find-generic-password');
    expect(keychain.items).toEqual({ k: 'v' });
    await vi.advanceTimersByTimeAsync(COMMAND_LIMIT_MS - WRITE_ANSWERS_AFTER_MS - 1);
    await afterPendingIo();
    expect(attempt.state()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await afterPendingIo();

    expect(attempt.state()).toBe('rejected');
    expect(attempt.error()).toBeInstanceOf(StoreCallEndedError);
    expect(`momonga: ${describeFailure(attempt.error())}\n`).toBe(
      `momonga: the read of the secret "k" did not finish within the command limit of 300000 ms; ${KEYCHAIN_UNANSWERED_ADVICE}; run the command again\n`,
    );
    expect(stdout).toEqual([]);
    expect(keychain.port.ended.map((ended) => ended.args[0])).toEqual(['find-generic-password']);
  });

  it('an interrupt during the store call is not reported as a limit', async () => {
    useLimitTimers();
    const keychain = keychainFixture({ control: { calls: 'hang' } });
    const { ports, stdout } = secretSetPorts(keychain.store, 'v\rv\r');
    const interrupt = interruptOf();
    const reason = new Error('the person pressed Ctrl-C');

    const attempt = secretSet(ports, momongaLayout('/home/u'), 'k', interrupt.signal);
    await keychain.arrived('add-generic-password');
    interrupt.abort(reason);

    await expect(attempt).rejects.toBe(reason);
    expect(stdout).toEqual([]);
  });
});
