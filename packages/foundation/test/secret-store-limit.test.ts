import { describe, expect, it } from 'vitest';
import { CREDENTIAL_MANAGER_BACKEND, KEYCHAIN_BACKEND, SECRET_SERVICE_BACKEND } from '@momonga/foundation/secret-store';
import {
  OperationLimitError,
  SECRET_TOOL_BINARY,
  SECURITY_BINARY,
  StoreCallEndedError,
  createCredentialManagerStore,
  createKeychainSecretStore,
  createSecretServiceStore,
  endedStoreCall,
  limitEndOf,
  limitEndText,
} from '@momonga/foundation';
import type { SecretStore } from '@momonga/foundation';
import { createFakeSecretFiles, createFakeSecurityPort } from '@momonga/testkit';
import type { FakeControl, FakeSecurityPort } from '@momonga/testkit';
import {
  KEYCHAIN_PATH,
  KEYCHAIN_UNANSWERED_ADVICE,
  aFile,
  answering,
  deferred,
  fakeLimit,
  hanging,
  keychainFilePresent,
  perCommandPort,
  recordingFiles,
  rejection,
  settlementOf,
  rejectionsReported,
  unhandledRejections,
  until,
} from './support/secret-store-fakes.ts';

const READINESS_ARGS = ['default-keychain'];
const FIND_K_ARGS = ['find-generic-password', '-s', 'momonga', '-a', 'k', '-w'];

const READ_SENTENCE = `the read of the secret "k" did not finish within the command limit of 300000 ms; ${KEYCHAIN_UNANSWERED_ADVICE}`;
const WRITE_SENTENCE = `the write of the secret "k" did not finish within the command limit of 300000 ms; ${KEYCHAIN_UNANSWERED_ADVICE}`;

const keychainOver = (control: FakeControl): { store: SecretStore; port: FakeSecurityPort; written: string[] } => {
  const written: string[] = [];
  const port = createFakeSecurityPort(() => ({ k: 'held' }), (name) => void written.push(name), { control: () => control });
  return { store: createKeychainSecretStore(port, SECURITY_BINARY, createFakeSecretFiles(() => new Set([KEYCHAIN_PATH]))), port, written };
};

const expectEndedCall = (error: unknown, action: 'read' | 'write', limitReason: unknown, sentence: string): void => {
  expect((error as Error).name).toBe('StoreCallEndedError');
  expect(error).toBeInstanceOf(StoreCallEndedError);
  expect((error as StoreCallEndedError).call).toEqual({ action, name: 'k', backend: KEYCHAIN_BACKEND });
  expect((error as StoreCallEndedError).call.backend).toBe(KEYCHAIN_BACKEND);
  expect(limitReason).toBeInstanceOf(OperationLimitError);
  expect((error as StoreCallEndedError).limit).toBe(limitReason);
  expect((error as Error).cause).toBe(limitReason);
  expect((error as Error).message).toBe(sentence);
};

describe('a secret-store call ended by the limit of the operation that asked', () => {
  it('a limit ending the real read throws StoreCallEndedError', async () => {
    const { limit, signal, pass } = fakeLimit(300000, 'the command limit');
    const { store, port } = keychainOver({ readiness: 'ready', calls: 'hang' });
    const attempt = store.read('k', signal);
    const settlement = settlementOf(attempt);
    await until(() => port.calls.length === 2, 'the find call started');
    expect(settlement.current()).toBe('pending');
    pass();
    expectEndedCall(await rejection(attempt), 'read', signal.reason, READ_SENTENCE);
    expect(port.calls.map((call) => call.args)).toEqual([READINESS_ARGS, FIND_K_ARGS]);
    expect(port.ended).toEqual([{ file: SECURITY_BINARY, args: FIND_K_ARGS, reason: signal.reason }]);
    limit.dispose();
  });

  it('a limit ending the real write throws StoreCallEndedError', async () => {
    const { limit, signal, pass } = fakeLimit(300000, 'the command limit');
    const { store, port, written } = keychainOver({ readiness: 'ready', calls: 'hang' });
    const attempt = store.write('k', 'v', signal);
    await until(() => port.calls.length === 2, 'the add call started');
    pass();
    expectEndedCall(await rejection(attempt), 'write', signal.reason, WRITE_SENTENCE);
    expect(port.calls.map((call) => call.args)).toEqual([READINESS_ARGS, ['-i']]);
    expect(port.ended).toEqual([{ file: SECURITY_BINARY, args: ['-i'], reason: signal.reason }]);
    expect(written).toEqual([]);
    limit.dispose();
  });

  it('a limit ending the readiness call', async () => {
    const { limit, signal, pass } = fakeLimit(300000, 'the command limit');
    const { store, port } = keychainOver({ readiness: 'hang', calls: 'answer' });
    const attempt = store.read('k', signal);
    const settlement = settlementOf(attempt);
    await until(() => port.calls.length === 1, 'the readiness call started');
    expect(settlement.current()).toBe('pending');
    pass();
    expectEndedCall(await rejection(attempt), 'read', signal.reason, READ_SENTENCE);
    expect(port.calls.map((call) => call.args)).toEqual([READINESS_ARGS]);
    expect(port.ended).toEqual([{ file: SECURITY_BINARY, args: READINESS_ARGS, reason: signal.reason }]);
    limit.dispose();
  });

  it.for(['resolves', 'rejects'] as const)('a limit ending the existence check (the check %s afterwards)', async (late) => {
    const unhandled = unhandledRejections();
    try {
      const { limit, signal, pass } = fakeLimit(300000, 'the command limit');
      const stat = deferred<{ isFile(): boolean }>();
      const files = recordingFiles(() => stat.promise);
      const fake = perCommandPort({ call: answering({ exitCode: 0, stdout: 'held\n', stderr: '' }) });
      const attempt = createKeychainSecretStore(fake.port, SECURITY_BINARY, files.files).read('k', signal);
      await until(() => files.asked.length === 1, 'the existence check started');
      pass();
      expectEndedCall(await rejection(attempt), 'read', signal.reason, READ_SENTENCE);
      if (late === 'resolves') stat.resolve({ isFile: () => true });
      else stat.reject(Object.assign(new Error('EIO: the mount came back'), { code: 'EIO' }));
      await rejectionsReported();
      expect(fake.calls.map((call) => call.args)).toEqual([READINESS_ARGS]);
      expect(files.asked).toEqual([KEYCHAIN_PATH]);
      expect(unhandled.seen).toEqual([]);
      limit.dispose();
    } finally {
      unhandled.stop();
    }
  });

  it.for(['readiness', 'real call', 'stat'] as const)('any other reason passes through by identity (%s)', async (point) => {
    const controller = new AbortController();
    const stat = deferred<{ isFile(): boolean }>();
    const files = recordingFiles(point === 'stat' ? () => stat.promise : aFile);
    const fake = perCommandPort({
      ...(point === 'readiness' ? { readiness: hanging } : {}),
      call: point === 'real call' ? hanging : answering({ exitCode: 0, stdout: 'held\n', stderr: '' }),
    });
    const attempt = createKeychainSecretStore(fake.port, SECURITY_BINARY, files.files).read('k', controller.signal);
    const settlement = settlementOf(attempt);
    if (point === 'readiness') await until(() => fake.calls.length === 1, 'the readiness call started');
    if (point === 'real call') await until(() => fake.calls.length === 2, 'the find call started');
    if (point === 'stat') await until(() => files.asked.length === 1, 'the existence check started');
    expect(settlement.current()).toBe('pending');
    const reason = new Error('interrupted by the user');
    controller.abort(reason);
    expect(await rejection(attempt)).toBe(reason);
    expect(fake.calls).toHaveLength(point === 'real call' ? 2 : 1);
  });

  it('any other reason passes through by identity (already aborted)', async () => {
    const controller = new AbortController();
    const reason = new Error('interrupted by the user');
    controller.abort(reason);
    const fake = perCommandPort({ call: answering({ exitCode: 0, stdout: 'held\n', stderr: '' }) });
    const files = keychainFilePresent();
    const store = createKeychainSecretStore(fake.port, SECURITY_BINARY, files.files);
    expect(await rejection(store.read('k', controller.signal))).toBe(reason);
    expect(await rejection(store.write('k', 'v', controller.signal))).toBe(reason);
    expect(fake.calls).toEqual([]);
    expect(files.asked).toEqual([]);
  });

  it.for(['read', 'write'] as const)('an already aborted limit makes no port call (%s)', async (action) => {
    const { limit, signal, pass } = fakeLimit(300000, 'the command limit');
    pass();
    const fake = perCommandPort({ call: answering({ exitCode: 0, stdout: 'held\n', stderr: '' }) });
    const files = keychainFilePresent();
    const store = createKeychainSecretStore(fake.port, SECURITY_BINARY, files.files);
    const error = await rejection(action === 'read' ? store.read('k', signal) : store.write('k', 'v', signal));
    expectEndedCall(error, action, signal.reason, action === 'read' ? READ_SENTENCE : WRITE_SENTENCE);
    expect(fake.calls).toEqual([]);
    expect(files.asked).toEqual([]);
    limit.dispose();
  });

  it('checks the name and the value before the signal', async () => {
    const { limit, signal, pass } = fakeLimit(300000, 'the command limit');
    pass();
    const fake = perCommandPort({ call: answering({ exitCode: 0, stdout: 'held\n', stderr: '' }) });
    const store = createKeychainSecretStore(fake.port, SECURITY_BINARY, keychainFilePresent().files);
    expect(await rejection(store.read('a b', signal))).toBeInstanceOf(RangeError);
    expect(await rejection(store.write('k', '', signal))).toBeInstanceOf(RangeError);
    expect(fake.calls).toEqual([]);
    limit.dispose();
  });

  it.for([
    [
      'Secret Service',
      'the read of the secret "k" did not finish within the command limit of 300000 ms; the Secret Service may be waiting for you to answer a prompt: answer it or unlock the keyring',
    ],
    ['Credential Manager', 'the read of the secret "k" did not finish within the command limit of 300000 ms'],
  ] as const)("the sentence carries the backend's own advice (%s)", async ([label, sentence]) => {
    const { limit, signal, pass } = fakeLimit(300000, 'the command limit');
    const fake = perCommandPort({ call: hanging });
    const store =
      label === 'Secret Service'
        ? createSecretServiceStore(fake.port, SECRET_TOOL_BINARY)
        : createCredentialManagerStore(fake.port, { file: 'powershell.exe', args: (script) => ['-EncodedCommand', script] });
    const attempt = store.read('k', signal);
    await until(() => fake.calls.length === 1, 'the store call started');
    pass();
    const error = await rejection(attempt);
    expect((error as Error).name).toBe('StoreCallEndedError');
    expect(error).toBeInstanceOf(StoreCallEndedError);
    expect((error as StoreCallEndedError).call.backend).toBe(label === 'Secret Service' ? SECRET_SERVICE_BACKEND : CREDENTIAL_MANAGER_BACKEND);
    expect((error as Error).message).toBe(sentence);
    expect((error as Error).message).not.toMatch(/keychain/i);
    expect((error as Error).message).not.toContain('security');
    limit.dispose();
  });
});

describe('StoreCallEndedError and the limit found in a failure', () => {
  const limit = (): OperationLimitError => new OperationLimitError(300000, 'the command limit');
  const call = { action: 'write', name: 'k', backend: KEYCHAIN_BACKEND } as const;

  it('the follow-up tail is appended once', () => {
    const error = new StoreCallEndedError(call, limit(), 'run the command again');
    expect(error.message).toBe(`${WRITE_SENTENCE}; run the command again`);
    expect(error.message.endsWith('; run the command again')).toBe(true);
    expect(error.message.split('run the command again')).toHaveLength(2);
    expect(new StoreCallEndedError(call, limit()).message).toBe(WRITE_SENTENCE);
  });

  it('names the key of the stored credentials when the call carries no name', () => {
    const error = new StoreCallEndedError({ action: 'read', name: undefined, backend: KEYCHAIN_BACKEND }, new OperationLimitError(30000, 'the MCP connect limit'));
    expect(error.message).toBe(`the read of the key of the stored credentials did not finish within the MCP connect limit of 30000 ms; ${KEYCHAIN_UNANSWERED_ADVICE}`);
    expect(error.name).toBe('StoreCallEndedError');
  });

  it('endedStoreCall wraps a limit and returns any other reason itself', () => {
    const reason = limit();
    const ended = endedStoreCall(call, reason);
    expect(ended).toBeInstanceOf(StoreCallEndedError);
    expect((ended as StoreCallEndedError).call).toEqual(call);
    expect((ended as StoreCallEndedError).limit).toBe(reason);
    expect((ended as StoreCallEndedError).cause).toBe(reason);
    const interrupt = new Error('interrupted by the user');
    expect(endedStoreCall(call, interrupt)).toBe(interrupt);
    expect(endedStoreCall(call, 'a string reason')).toBe('a string reason');
  });

  it.for(['wrapped in a cause chain', 'a bare limit', 'no limit'] as const)('limitEndOf finds a limit in a cause chain and for a bare limit (%s)', (row) => {
    const reason = limit();
    const ended = new StoreCallEndedError(call, reason);
    if (row === 'wrapped in a cause chain') {
      expect(limitEndOf(new Error('the connect failed', { cause: new Error('the provider failed', { cause: ended }) }))).toEqual({ call, limit: reason });
      expect(limitEndOf(ended)).toEqual({ call, limit: reason });
      expect(limitEndOf(ended)?.limit).toBe(reason);
    } else if (row === 'a bare limit') {
      expect(limitEndOf(reason)).toEqual({ call: undefined, limit: reason });
      expect(limitEndOf(new Error('waiting for the lock failed', { cause: reason }))?.limit).toBe(reason);
    } else {
      expect(limitEndOf(new Error('plain'))).toBeUndefined();
      expect(limitEndOf(new Error('plain', { cause: new Error('deeper') }))).toBeUndefined();
      expect(limitEndOf(undefined)).toBeUndefined();
    }
  });
});

describe('the limit sentences of each OS store', () => {
  const SECRET_SERVICE_ADVICE = 'the Secret Service may be waiting for you to answer a prompt: answer it or unlock the keyring';
  const BACKENDS = [
    ['Keychain', KEYCHAIN_BACKEND, `; ${KEYCHAIN_UNANSWERED_ADVICE}`],
    ['Secret Service', SECRET_SERVICE_BACKEND, `; ${SECRET_SERVICE_ADVICE}`],
    ['Credential Manager', CREDENTIAL_MANAGER_BACKEND, ''],
  ] as const;
  const ROWS = BACKENDS.flatMap(([label, backend, advice]) => (['read', 'write'] as const).map((action) => [label, action, backend, advice] as const));

  it.for(ROWS)('the %s %s that did not finish', ([, action, backend, advice]) => {
    const commandLimit = new OperationLimitError(300000, 'the command limit');
    const connectLimit = new OperationLimitError(30000, 'the MCP connect limit');
    const named = `the ${action} of the secret "k" did not finish within the command limit of 300000 ms${advice}`;
    const nameless = `the ${action} of the key of the stored credentials did not finish within the MCP connect limit of 30000 ms${advice}`;
    expect(new StoreCallEndedError({ action, name: 'k', backend }, commandLimit).message).toBe(named);
    expect(new StoreCallEndedError({ action, name: 'k', backend }, commandLimit, 'run the command again').message).toBe(`${named}; run the command again`);
    expect(new StoreCallEndedError({ action, name: undefined, backend }, connectLimit).message).toBe(nameless);
    expect(limitEndText({ call: { action, name: 'k', backend }, limit: commandLimit }, 'waiting for the credential store')).toBe(named);
    expect(limitEndText({ call: { action, name: undefined, backend }, limit: connectLimit }, 'waiting for the credential store')).toBe(nameless);
  });

  it.for(['read', 'write'] as const)('the %s through a store whose backend is not known carries no advice', (action) => {
    const commandLimit = new OperationLimitError(300000, 'the command limit');
    const sentence = `the ${action} of the secret "k" did not finish within the command limit of 300000 ms`;
    expect(new StoreCallEndedError({ action, name: 'k', backend: undefined }, commandLimit).message).toBe(sentence);
    expect(limitEndText({ call: { action, name: 'k', backend: undefined }, limit: commandLimit }, 'waiting for the credential store')).toBe(sentence);
  });

  it('a bare limit takes the subject of the asker', () => {
    const connectLimit = new OperationLimitError(30000, 'the MCP connect limit');
    expect(limitEndText({ call: undefined, limit: connectLimit }, 'waiting for the credential store')).toBe('waiting for the credential store did not finish within the MCP connect limit of 30000 ms');
    expect(limitEndText({ call: undefined, limit: connectLimit }, 'the connect')).toBe('the connect did not finish within the MCP connect limit of 30000 ms');
  });

  it('the examples of the design, word for word', () => {
    const commandLimit = new OperationLimitError(300000, 'the command limit');
    expect(new StoreCallEndedError({ action: 'write', name: 'k', backend: KEYCHAIN_BACKEND }, commandLimit, 'run the command again').message).toBe(
      'the write of the secret "k" did not finish within the command limit of 300000 ms; the Keychain may be waiting for an answer in a window on your screen: answer it or unlock the login keychain; run the command again',
    );
    expect(new StoreCallEndedError({ action: 'read', name: 'k', backend: SECRET_SERVICE_BACKEND }, commandLimit, 'run the command again').message).toBe(
      'the read of the secret "k" did not finish within the command limit of 300000 ms; the Secret Service may be waiting for you to answer a prompt: answer it or unlock the keyring; run the command again',
    );
    expect(new StoreCallEndedError({ action: 'read', name: 'k', backend: CREDENTIAL_MANAGER_BACKEND }, commandLimit, 'run the command again').message).toBe(
      'the read of the secret "k" did not finish within the command limit of 300000 ms; run the command again',
    );
  });
});
