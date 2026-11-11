import { describe, expect, it } from 'vitest';
import { KEYCHAIN_SERVICE, SECRET_TOOL_BINARY, SECURITY_BINARY, SecretUnavailableError, StoreCallEndedError, operationLimit } from '@momonga/foundation';
import {
  READY_CONTROL,
  createFakeClock,
  createFakeSecretFiles,
  createFakeSecretStore,
  createFakeSecurityPort,
  createFakeTimers,
  fakeReadinessAnswer,
} from '../src/index.ts';
import type { FakeControl, FakeReadiness } from '../src/index.ts';
import { afterMicrotasks } from '../src/index.ts';

const NEVER_ABORTED = new AbortController().signal;

const DEFAULT_KEYCHAIN_PATH = '/Users/x/Library/Keychains/login.keychain-db';
const READY_ANSWER = { exitCode: 0, stdout: '    "/Users/x/Library/Keychains/login.keychain-db"\n', stderr: '' };
const NONE_ANSWER = { exitCode: 1, stdout: '', stderr: 'security: SecKeychainCopyDefault: A default keychain could not be found.\n' };
const GARBAGE_ANSWER = { exitCode: 0, stdout: 'garbage\n', stderr: '' };

const FIND_MAIN = ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'main', '-w'];

const settlementOf = (attempt: Promise<unknown>): { current(): unknown } => {
  let state: unknown = 'pending';
  attempt.then(
    (value) => {
      state = { resolved: value };
    },
    (error: unknown) => {
      state = { rejected: error };
    },
  );
  return { current: () => state };
};

const turn = afterMicrotasks;

describe('createFakeSecurityPort', () => {
  it('answers a find-generic-password invocation and records it', async () => {
    const port = createFakeSecurityPort(() => ({ main: 'value' }));
    expect(await port(SECURITY_BINARY, FIND_MAIN, '', NEVER_ABORTED)).toEqual({ exitCode: 0, stdout: 'value\n', stderr: '' });
    expect(port.calls).toEqual([{ file: SECURITY_BINARY, args: FIND_MAIN, stdin: '' }]);
  });

  it('answers exit 44 for an absent item', async () => {
    const port = createFakeSecurityPort(() => ({}));
    const result = await port(SECURITY_BINARY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'gone', '-w'], '', NEVER_ABORTED);
    expect(result.exitCode).toBe(44);
  });

  it.for([
    ['/usr/bin/other', FIND_MAIN, ''],
    [SECURITY_BINARY, ['add-generic-password', '-s', KEYCHAIN_SERVICE, '-a', 'main', '-w', 'leaked'], ''],
    [SECURITY_BINARY, ['find-generic-password', '-s', 'other-service', '-a', 'main', '-w'], ''],
    [SECURITY_BINARY, FIND_MAIN, 'stdin'],
    [SECURITY_BINARY, ['-i'], 'add-generic-password -w leaked\n'],
    ['/usr/bin/other', ['default-keychain'], ''],
    [SECURITY_BINARY, ['default-keychain'], 'stdin'],
    [SECURITY_BINARY, ['default-keychain', '-d', 'user'], ''],
    [SECRET_TOOL_BINARY, ['default-keychain'], ''],
  ] as const)('rejects the unexpected invocation %j', async ([file, args, stdin]) => {
    const port = createFakeSecurityPort(() => ({ main: 'value' }));
    await expect(port(file, args, stdin, NEVER_ABORTED)).rejects.toThrow('unexpected invocation');
  });
});

describe('fakeReadinessAnswer', () => {
  it.for([
    ['ready', READY_ANSWER],
    ['gone', READY_ANSWER],
    ['none', NONE_ANSWER],
    ['garbage', GARBAGE_ANSWER],
  ] as const)('gives the bytes of a %s default-keychain answer', ([readiness, answer]) => {
    expect(fakeReadinessAnswer(readiness, DEFAULT_KEYCHAIN_PATH)).toEqual(answer);
  });

  it('quotes the path it is given after four spaces', () => {
    expect(fakeReadinessAnswer('ready', '/p').stdout).toBe('    "/p"\n');
  });

  it('names ready with answering calls as the ready control', () => {
    expect(READY_CONTROL).toEqual({ readiness: 'ready', calls: 'answer' });
  });
});

describe('createFakeSecurityPort readiness', () => {
  it.for([
    [undefined, READY_ANSWER],
    ['ready', READY_ANSWER],
    ['none', NONE_ANSWER],
    ['gone', READY_ANSWER],
    ['garbage', GARBAGE_ANSWER],
  ] as const)('the port answers default-keychain by its control (%s)', async ([readiness, answer]) => {
    const port = createFakeSecurityPort(() => ({}), undefined, readiness === undefined ? undefined : { control: () => ({ readiness, calls: 'answer' }) });
    expect(await port(SECURITY_BINARY, ['default-keychain'], '', NEVER_ABORTED)).toEqual(answer);
    expect(answer).toEqual(fakeReadinessAnswer(readiness ?? 'ready', DEFAULT_KEYCHAIN_PATH));
    expect(port.calls).toEqual([{ file: SECURITY_BINARY, args: ['default-keychain'], stdin: '' }]);
    expect(port.ended).toEqual([]);
  });

  it('prints the keychain path it was given', async () => {
    const port = createFakeSecurityPort(() => ({}), undefined, { keychainPath: '/p' });
    expect(await port(SECURITY_BINARY, ['default-keychain'], '', NEVER_ABORTED)).toEqual({ exitCode: 0, stdout: '    "/p"\n', stderr: '' });
  });

  it('reads its control at every call', async () => {
    let readiness: FakeReadiness = 'ready';
    const port = createFakeSecurityPort(() => ({}), undefined, { control: () => ({ readiness, calls: 'answer' }) });
    expect(await port(SECURITY_BINARY, ['default-keychain'], '', NEVER_ABORTED)).toEqual(READY_ANSWER);
    readiness = 'none';
    expect(await port(SECURITY_BINARY, ['default-keychain'], '', NEVER_ABORTED)).toEqual(NONE_ANSWER);
  });

  it.for([
    ['the readiness call', { readiness: 'hang', calls: 'answer' }, ['default-keychain'], FIND_MAIN],
    ['an item call', { readiness: 'ready', calls: 'hang' }, FIND_MAIN, ['default-keychain']],
  ] as const)('a hanging port rejects with the signal\'s reason and records the end (%s)', async ([, control, hanging, answering]) => {
    const port = createFakeSecurityPort(() => ({ main: 'value' }), undefined, { control: (): FakeControl => control });
    expect((await port(SECURITY_BINARY, answering, '', NEVER_ABORTED)).exitCode).toBe(0);
    const controller = new AbortController();
    const attempt = port(SECURITY_BINARY, hanging, '', controller.signal);
    const settlement = settlementOf(attempt);
    await turn();
    expect(settlement.current()).toBe('pending');
    expect(port.ended).toEqual([]);
    const reason = new Error('the caller left');
    controller.abort(reason);
    await expect(attempt).rejects.toBe(reason);
    expect(port.ended).toEqual([{ file: SECURITY_BINARY, args: hanging, reason }]);
    expect(port.calls.map((call) => call.args)).toEqual([answering, hanging]);
  });

  it('a hanging port given an already aborted signal rejects at once with its reason', async () => {
    const port = createFakeSecurityPort(() => ({}), undefined, { control: () => ({ readiness: 'hang', calls: 'hang' }) });
    const controller = new AbortController();
    const reason = new Error('already gone');
    controller.abort(reason);
    await expect(port(SECURITY_BINARY, ['default-keychain'], '', controller.signal)).rejects.toBe(reason);
    expect(port.ended).toEqual([{ file: SECURITY_BINARY, args: ['default-keychain'], reason }]);
  });

  it('a hanging write hands nothing to onWrite', async () => {
    const written: string[] = [];
    const port = createFakeSecurityPort(() => ({}), (name) => void written.push(name), { control: () => ({ readiness: 'ready', calls: 'hang' }) });
    const controller = new AbortController();
    const stdin = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a main -X ${Buffer.from('v', 'utf8').toString('hex')}\n`;
    const attempt = port(SECURITY_BINARY, ['-i'], stdin, controller.signal);
    const reason = new Error('the caller left');
    controller.abort(reason);
    await expect(attempt).rejects.toBe(reason);
    expect(written).toEqual([]);
  });
});

describe('createFakeSecretFiles', () => {
  it.for([
    ['present', true],
    ['absent', false],
  ] as const)('the fake files port (%s)', async ([, present]) => {
    const existing = new Set<string>(present ? ['/p'] : []);
    const files = createFakeSecretFiles(() => existing);
    if (present) {
      expect((await files.stat('/p')).isFile()).toBe(true);
    } else {
      await expect(files.stat('/p')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('reads the set at every call', async () => {
    const existing = new Set<string>();
    const files = createFakeSecretFiles(() => existing);
    await expect(files.stat('/p')).rejects.toMatchObject({ code: 'ENOENT' });
    existing.add('/p');
    expect((await files.stat('/p')).isFile()).toBe(true);
  });
});

describe('createFakeSecurityPort writes', () => {
  it('decodes the hex value of an interactive add-generic-password and hands it to onWrite', async () => {
    const written: Array<[string, string]> = [];
    const port = createFakeSecurityPort(() => ({}), (name, value) => void written.push([name, value]));
    const stdin = `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a main -X ${Buffer.from('sk-fake', 'utf8').toString('hex')}\n`;
    expect(await port(SECURITY_BINARY, ['-i'], stdin, NEVER_ABORTED)).toEqual({ exitCode: 0, stdout: '', stderr: '' });
    expect(written).toEqual([['main', 'sk-fake']]);
  });
});

describe('createFakeSecretStore', () => {
  it('reads configured secrets, records the reads and raises the typed error for an absent one', async () => {
    const store = createFakeSecretStore({ a: 'one' });
    expect(await store.read('a', NEVER_ABORTED)).toBe('one');
    await expect(store.read('b', NEVER_ABORTED)).rejects.toBeInstanceOf(SecretUnavailableError);
    expect(store.reads).toEqual(['a', 'b']);
  });

  it('records a write and reads it back', async () => {
    const store = createFakeSecretStore({});
    await store.write('k', 'v', NEVER_ABORTED);
    expect(store.writes).toEqual([{ name: 'k', value: 'v' }]);
    expect(await store.read('k', NEVER_ABORTED)).toBe('v');
  });

  it.for(['read', 'write'] as const)('a hanging store rejects with StoreCallEndedError on a limit (%s)', async (action) => {
    const timers = createFakeTimers(createFakeClock(0));
    const limit = operationLimit(NEVER_ABORTED, 300000, 'the command limit', timers);
    const store = createFakeSecretStore({ k: 'held' }, { calls: () => 'hang' });
    const attempt = action === 'read' ? store.read('k', limit.signal) : store.write('k', 'v', limit.signal);
    const settlement = settlementOf(attempt);
    await turn();
    expect(settlement.current()).toBe('pending');
    timers.advance(300000);
    const error = await attempt.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(StoreCallEndedError);
    expect((error as StoreCallEndedError).call).toEqual({ action, name: 'k', backend: undefined });
    expect((error as StoreCallEndedError).limit).toBe(limit.signal.reason);
    expect((error as Error).message).toBe(`the ${action} of the secret "k" did not finish within the command limit of 300000 ms`);
    expect(store.writes).toEqual([]);
  });

  it('a hanging store rejects with any other reason itself', async () => {
    const store = createFakeSecretStore({ k: 'held' }, { calls: () => 'hang' });
    const controller = new AbortController();
    const attempt = store.read('k', controller.signal);
    const reason = new Error('interrupted');
    controller.abort(reason);
    await expect(attempt).rejects.toBe(reason);
  });

  it('reads its call mode at every call', async () => {
    let calls: FakeControl['calls'] = 'hang';
    const store = createFakeSecretStore({ k: 'held' }, { calls: () => calls });
    const controller = new AbortController();
    const hung = store.read('k', controller.signal);
    hung.catch(() => undefined);
    calls = 'answer';
    expect(await store.read('k', NEVER_ABORTED)).toBe('held');
    controller.abort(new Error('done'));
    await expect(hung).rejects.toThrow();
  });
});
