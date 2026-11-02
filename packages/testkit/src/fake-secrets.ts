import { KEYCHAIN_SERVICE, SECURITY_BINARY, SecretUnavailableError } from '@momonga/foundation';
import type { SecretProcessPort, SecretStore } from '@momonga/foundation';

export type FakeSecretStore = SecretStore & { readonly reads: string[] };

const ITEM_NOT_FOUND_EXIT = 44;

export const createFakeSecretStore = (secrets: Readonly<Record<string, string>>): FakeSecretStore => {
  const reads: string[] = [];
  return {
    reads,
    read: async (name) => {
      reads.push(name);
      const value = secrets[name];
      if (value === undefined) throw new SecretUnavailableError(name, ITEM_NOT_FOUND_EXIT, 'the fake store has no such secret');
      return value;
    },
  };
};

export type FakeSecurityPort = SecretProcessPort & { readonly calls: Array<{ file: string; args: readonly string[]; stdin: string }> };

export const createFakeSecurityPort = (secrets: () => Readonly<Record<string, string>>): FakeSecurityPort => {
  const calls: FakeSecurityPort['calls'] = [];
  const port: SecretProcessPort = async (file, args, stdin) => {
    calls.push({ file, args, stdin });
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
    const value = secrets()[account];
    if (value === undefined) return { exitCode: ITEM_NOT_FOUND_EXIT, stdout: '', stderr: 'the fake keychain has no such item\n' };
    return { exitCode: 0, stdout: `${value}\n`, stderr: '' };
  };
  return Object.assign(port, { calls });
};
