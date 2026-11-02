import { KEYCHAIN_SERVICE, SECRET_TOOL_BINARY, SECURITY_BINARY, SecretUnavailableError } from '@momonga/foundation';
import type { SecretProcessPort, SecretStore } from '@momonga/foundation';

export type FakeSecretStore = SecretStore & { readonly reads: string[]; readonly writes: Array<{ name: string; value: string }> };

const ITEM_NOT_FOUND_EXIT = 44;

export const createFakeSecretStore = (secrets: Readonly<Record<string, string>>): FakeSecretStore => {
  const reads: string[] = [];
  const writes: FakeSecretStore['writes'] = [];
  const held = new Map(Object.entries(secrets));
  return {
    reads,
    writes,
    read: async (name) => {
      reads.push(name);
      const value = held.get(name);
      if (value === undefined) throw new SecretUnavailableError(name, ITEM_NOT_FOUND_EXIT, 'the fake store has no such secret');
      return value;
    },
    write: async (name, value) => {
      writes.push({ name, value });
      held.set(name, value);
    },
  };
};

export type FakeSecurityPort = SecretProcessPort & { readonly calls: Array<{ file: string; args: readonly string[]; stdin: string }> };

const WRITE_COMMAND = /^add-generic-password -U -s ([^ ]+) -a ([^ ]+) -X ([0-9a-f]+)\n$/;

export const createFakeSecurityPort = (
  secrets: () => Readonly<Record<string, string>>,
  onWrite: (name: string, value: string) => void = () => {
    throw new Error('the fake security port was given a write but no onWrite handler');
  },
): FakeSecurityPort => {
  const calls: FakeSecurityPort['calls'] = [];
  const port: SecretProcessPort = async (file, args, stdin) => {
    calls.push({ file, args, stdin });
    const write = file === SECURITY_BINARY && args.length === 1 && args[0] === '-i' ? WRITE_COMMAND.exec(stdin) : null;
    if (write !== null && write[1] === KEYCHAIN_SERVICE) {
      onWrite(write[2] as string, Buffer.from(write[3] as string, 'hex').toString('utf8'));
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (file === SECRET_TOOL_BINARY && args.length === 6 && args[0] === `store` && args[1] === `--label=${KEYCHAIN_SERVICE}` && args[2] === 'service' && args[3] === KEYCHAIN_SERVICE && args[4] === 'account') {
      onWrite(args[5] as string, stdin);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (file === SECRET_TOOL_BINARY && args.length === 5 && args[0] === 'lookup' && args[1] === 'service' && args[2] === KEYCHAIN_SERVICE && args[3] === 'account' && stdin === '') {
      const stored = secrets()[args[4] as string];
      if (stored === undefined) return { exitCode: 1, stdout: '', stderr: '' };
      return { exitCode: 0, stdout: stored, stderr: '' };
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
    const value = secrets()[account];
    if (value === undefined) return { exitCode: ITEM_NOT_FOUND_EXIT, stdout: '', stderr: 'the fake keychain has no such item\n' };
    return { exitCode: 0, stdout: `${value}\n`, stderr: '' };
  };
  return Object.assign(port, { calls });
};
