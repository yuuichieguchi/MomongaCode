import { SECURITY_BINARY, createKeychainSecretStore } from '@momonga/foundation';
import type { SecretProcessPort, SecretStore } from '@momonga/foundation';
import { FAKE_KEYCHAIN_PATH, READY_CONTROL, createFakeSecretFiles, createFakeSecurityPort } from '@momonga/testkit';
import type { FakeControl, FakeSecurityPort } from '@momonga/testkit';
import { vi } from 'vitest';
import type { CliPorts, Terminal } from '../src/ports.ts';

export const KEYCHAIN_PATH = FAKE_KEYCHAIN_PATH;

export const NO_DEFAULT_KEYCHAIN_REASON = 'security reports no default keychain (SecKeychainCopyDefault: A default keychain could not be found.)';

export const KEYCHAIN_UNANSWERED_ADVICE = 'the Keychain may be waiting for an answer in a window on your screen: answer it or unlock the login keychain';

export type KeychainCommand = 'default-keychain' | 'find-generic-password' | 'add-generic-password';

export type KeychainFixture = {
  store: SecretStore;
  port: FakeSecurityPort;
  control: FakeControl;
  items: Record<string, string>;
  arrived(command: KeychainCommand, count?: number): Promise<void>;
};

export type KeychainFixtureOptions = {
  items?: Readonly<Record<string, string>>;
  control?: Partial<FakeControl>;
  beforeAnswer?: (command: KeychainCommand, account: string | undefined) => Promise<void>;
};

const commandOf = (args: readonly string[], stdin: string): KeychainCommand => (args[0] === '-i' ? (stdin.split(' ')[0] as KeychainCommand) : (args[0] as KeychainCommand));

const accountOf = (args: readonly string[], stdin: string): string | undefined => {
  const words = args[0] === '-i' ? stdin.trimEnd().split(' ') : args;
  const flag = words.indexOf('-a');
  return flag === -1 ? undefined : words[flag + 1];
};

export const keychainFixture = (options: KeychainFixtureOptions = {}): KeychainFixture => {
  const items: Record<string, string> = { ...options.items };
  const control: FakeControl = { ...READY_CONTROL, ...options.control };
  const port = createFakeSecurityPort(
    () => items,
    (name, value) => {
      items[name] = value;
    },
    { control: () => control, keychainPath: KEYCHAIN_PATH },
  );
  const counts = new Map<KeychainCommand, number>();
  const waiters: Array<{ command: KeychainCommand; count: number; resolve(): void }> = [];
  const run: SecretProcessPort = async (file, args, stdin, signal) => {
    const command = commandOf(args, stdin);
    const count = (counts.get(command) ?? 0) + 1;
    counts.set(command, count);
    for (const waiter of waiters.splice(0)) {
      if (waiter.command === command && waiter.count <= count) waiter.resolve();
      else waiters.push(waiter);
    }
    await options.beforeAnswer?.(command, accountOf(args, stdin));
    return port(file, args, stdin, signal);
  };
  const files = createFakeSecretFiles(() => new Set([KEYCHAIN_PATH]));
  return {
    store: createKeychainSecretStore(run, SECURITY_BINARY, files),
    port,
    control,
    items,
    arrived: (command, count = 1) =>
      new Promise<void>((resolve) => {
        if ((counts.get(command) ?? 0) >= count) resolve();
        else waiters.push({ command, count, resolve });
      }),
  };
};

export type Outcome<T> = { state(): 'pending' | 'fulfilled' | 'rejected'; value(): T | undefined; error(): unknown };

export const outcomeOf = <T>(pending: Promise<T>): Outcome<T> => {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  let value: T | undefined;
  let error: unknown;
  pending.then(
    (settled) => {
      state = 'fulfilled';
      value = settled;
    },
    (failure: unknown) => {
      state = 'rejected';
      error = failure;
    },
  );
  return { state: () => state, value: () => value, error: () => error };
};

const SETTLE_WAIT = { timeout: 2_000, interval: 0 };

export const settledAfter = async <T>(outcome: Outcome<T>): Promise<Outcome<T>> => {
  await vi.waitFor(() => {
    if (outcome.state() === 'pending') throw new Error('the operation has not settled');
  }, SETTLE_WAIT);
  return outcome;
};

export const stillPendingAfter = async (outcome: Outcome<unknown>, ms: number): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms);
  if (outcome.state() !== 'pending') throw new Error(`the operation settled ${outcome.state()} before its limit: ${String(outcome.error() ?? outcome.value())}`);
};

export const useLimitTimers = (): void => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
};

export const typingTerminal = (typed: string): Terminal => {
  const stdin = {
    setRawMode: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    on: (_event: string, listener: (chunk: string) => void) => {
      listener(typed);
      return stdin;
    },
    off: () => stdin,
  };
  return { stdin, stdout: { write: () => true } } as unknown as Terminal;
};

export const secretSetPorts = (store: SecretStore, typed: string): { ports: CliPorts; stdout: string[] } => {
  const stdout: string[] = [];
  const ports = { terminal: typingTerminal(typed), secretStore: () => store, stdout: { write: (text: string) => void stdout.push(text) } } as unknown as CliPorts;
  return { ports, stdout };
};
