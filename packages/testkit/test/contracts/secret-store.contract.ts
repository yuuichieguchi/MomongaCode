import { expect, it } from 'vitest';
import { SecretEmptyError, SecretUnavailableError } from '@momonga/foundation';
import type { SecretStore } from '@momonga/foundation';

const NEVER_ABORTED = new AbortController().signal;

export const secretStoreContract = (make: (secrets: Record<string, string>) => SecretStore): void => {
  it('reads what it holds and what it was given', async () => {
    const store = make({ main: 'value-1' });
    expect(await store.read('main', NEVER_ABORTED)).toBe('value-1');
    await store.write('other', 'value-2', NEVER_ABORTED);
    expect(await store.read('other', NEVER_ABORTED)).toBe('value-2');
  });

  it('answers a name it does not hold as unavailable', async () => {
    await expect(make({}).read('main', NEVER_ABORTED)).rejects.toBeInstanceOf(SecretUnavailableError);
  });

  it.each(['', '.hidden', 'a b', 'a/b', 'x'.repeat(129)])('refuses the name %j on read and on write', async (name) => {
    const store = make({});
    await expect(store.read(name, NEVER_ABORTED)).rejects.toBeInstanceOf(RangeError);
    await expect(store.write(name, 'value', NEVER_ABORTED)).rejects.toBeInstanceOf(RangeError);
  });

  it('refuses to write an empty value', async () => {
    await expect(make({}).write('main', '', NEVER_ABORTED)).rejects.toBeInstanceOf(RangeError);
  });

  it('answers an empty stored value as empty, never as a value', async () => {
    await expect(make({ main: '' }).read('main', NEVER_ABORTED)).rejects.toBeInstanceOf(SecretEmptyError);
  });
};
