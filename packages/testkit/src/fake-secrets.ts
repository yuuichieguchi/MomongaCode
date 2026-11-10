import * as foundation from '@momonga/foundation';
import { KEYCHAIN_SERVICE, SECRET_TOOL_BINARY, SECURITY_BINARY, SecretUnavailableError } from '@momonga/foundation';
import type { SecretProcessPort, SecretProcessResult, SecretStore } from '@momonga/foundation';
import type { SecretStoreFiles } from '@momonga/foundation/secret-store';

export type FakeReadiness = 'ready' | 'none' | 'gone' | 'garbage' | 'hang';
export type FakeCallMode = 'answer' | 'hang';
export type FakeControl = { readiness: FakeReadiness; calls: FakeCallMode };

export const FAKE_READINESS_VALUES: readonly FakeReadiness[] = ['ready', 'none', 'gone', 'garbage', 'hang'];
export const FAKE_CALL_MODES: readonly FakeCallMode[] = ['answer', 'hang'];

export const READY_CONTROL: FakeControl = { readiness: 'ready', calls: 'answer' };

export const FAKE_KEYCHAIN_PATH = '/Users/x/Library/Keychains/login.keychain-db';

const NO_DEFAULT_KEYCHAIN_STDERR = 'security: SecKeychainCopyDefault: A default keychain could not be found.\n';

export const fakeReadinessAnswer = (readiness: Exclude<FakeReadiness, 'hang'>, keychainPath: string): SecretProcessResult => {
  if (readiness === 'none') return { exitCode: 1, stdout: '', stderr: NO_DEFAULT_KEYCHAIN_STDERR };
  if (readiness === 'garbage') return { exitCode: 0, stdout: 'garbage\n', stderr: '' };
  return { exitCode: 0, stdout: `    "${keychainPath}"\n`, stderr: '' };
};

const rejectedWhenAborted = <T>(signal: AbortSignal, rejectionOf: (reason: unknown) => unknown): Promise<T> =>
  new Promise<T>((_resolve, reject) => {
    const end = (): void => {
      try {
        reject(rejectionOf(signal.reason));
      } catch (error) {
        reject(error);
      }
    };
    if (signal.aborted) end();
    else signal.addEventListener('abort', end, { once: true });
  });

export type FakeSecretStore = SecretStore & { readonly reads: string[]; readonly writes: Array<{ name: string; value: string }> };

export type FakeSecretStoreOptions = { calls?: () => FakeCallMode };

const ITEM_NOT_FOUND_EXIT = 44;

export const createFakeSecretStore = (secrets: Readonly<Record<string, string>>, options: FakeSecretStoreOptions = {}): FakeSecretStore => {
  const reads: string[] = [];
  const writes: FakeSecretStore['writes'] = [];
  const held = new Map(Object.entries(secrets));
  const hangs = (): boolean => options.calls?.() === 'hang';
  const hung = <T>(action: 'read' | 'write', name: string, signal: AbortSignal): Promise<T> =>
    rejectedWhenAborted<T>(signal, (reason) => foundation.endedStoreCall({ action, name, backend: undefined }, reason));
  return {
    reads,
    writes,
    read: async (name, signal) => {
      reads.push(name);
      if (hangs()) return hung<string>('read', name, signal);
      const value = held.get(name);
      if (value === undefined) throw new SecretUnavailableError(name, ITEM_NOT_FOUND_EXIT, 'the fake store has no such secret');
      return value;
    },
    write: async (name, value, signal) => {
      if (hangs()) return hung<void>('write', name, signal);
      writes.push({ name, value });
      held.set(name, value);
    },
  };
};

export const createFakeSecretFiles = (existing: () => ReadonlySet<string>): SecretStoreFiles => ({
  stat: async (path) => {
    if (existing().has(path)) return { isFile: () => true };
    throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${path}'`), { code: 'ENOENT' });
  },
});

export type FakeSecurityPort = SecretProcessPort & {
  readonly calls: Array<{ file: string; args: readonly string[]; stdin: string }>;
  readonly ended: Array<{ file: string; args: readonly string[]; reason: unknown }>;
};

export type FakeSecurityPortOptions = { control?: () => FakeControl; keychainPath?: string };

const WRITE_COMMAND = /^add-generic-password -U -s ([^ ]+) -a ([^ ]+) -X ([0-9a-f]+)\n$/;

const DONE: SecretProcessResult = { exitCode: 0, stdout: '', stderr: '' };

export const createFakeSecurityPort = (
  secrets: () => Readonly<Record<string, string>>,
  onWrite: (name: string, value: string) => void = () => {
    throw new Error('the fake security port was given a write but no onWrite handler');
  },
  options: FakeSecurityPortOptions = {},
): FakeSecurityPort => {
  const control = options.control ?? ((): FakeControl => READY_CONTROL);
  const keychainPath = options.keychainPath ?? FAKE_KEYCHAIN_PATH;
  const calls: FakeSecurityPort['calls'] = [];
  const ended: FakeSecurityPort['ended'] = [];

  const itemAnswerOf = (file: string, args: readonly string[], stdin: string): (() => SecretProcessResult) => {
    const write = file === SECURITY_BINARY && args.length === 1 && args[0] === '-i' ? WRITE_COMMAND.exec(stdin) : null;
    if (write !== null && write[1] === KEYCHAIN_SERVICE) {
      return () => {
        onWrite(write[2] as string, Buffer.from(write[3] as string, 'hex').toString('utf8'));
        return DONE;
      };
    }
    if (file === SECRET_TOOL_BINARY && args.length === 6 && args[0] === `store` && args[1] === `--label=${KEYCHAIN_SERVICE}` && args[2] === 'service' && args[3] === KEYCHAIN_SERVICE && args[4] === 'account') {
      return () => {
        onWrite(args[5] as string, stdin);
        return DONE;
      };
    }
    if (file === SECRET_TOOL_BINARY && args.length === 5 && args[0] === 'lookup' && args[1] === 'service' && args[2] === KEYCHAIN_SERVICE && args[3] === 'account' && stdin === '') {
      return () => {
        const stored = secrets()[args[4] as string];
        return stored === undefined ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: stored, stderr: '' };
      };
    }
    const [command, serviceFlag, service, accountFlag, account, printFlag, ...rest] = args;
    const recognised =
      file === SECURITY_BINARY &&
      command === 'find-generic-password' &&
      serviceFlag === '-s' &&
      service === KEYCHAIN_SERVICE &&
      accountFlag === '-a' &&
      account !== undefined &&
      printFlag === '-w' &&
      rest.length === 0 &&
      stdin === '';
    if (!recognised) throw new Error(`the fake security port received an unexpected invocation: ${file} ${args.join(' ')}`);
    return () => {
      const value = secrets()[account];
      return value === undefined ? { exitCode: ITEM_NOT_FOUND_EXIT, stdout: '', stderr: 'the fake keychain has no such item\n' } : { exitCode: 0, stdout: `${value}\n`, stderr: '' };
    };
  };

  const port: SecretProcessPort = async (file, args, stdin, signal) => {
    calls.push({ file, args, stdin });
    const hung = (): Promise<SecretProcessResult> =>
      rejectedWhenAborted<SecretProcessResult>(signal, (reason) => {
        ended.push({ file, args, reason });
        return reason;
      });
    if (file === SECURITY_BINARY && args.length === 1 && args[0] === 'default-keychain' && stdin === '') {
      const { readiness } = control();
      return readiness === 'hang' ? hung() : fakeReadinessAnswer(readiness, keychainPath);
    }
    const answer = itemAnswerOf(file, args, stdin);
    return control().calls === 'hang' ? hung() : answer();
  };
  return Object.assign(port, { calls, ended });
};
