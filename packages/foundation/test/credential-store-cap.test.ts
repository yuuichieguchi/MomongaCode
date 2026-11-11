import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTH_DOCUMENT_MAX_BYTES, createFileCredentialStore, credentialFileFor } from '@momonga/foundation';
import { makeTemporaryDirectory } from './support/temporary-directory.ts';

const SIGNAL = new AbortController().signal;

describe('the file credential store reads a credential with the size cap of an auth document', () => {
  it('refuses a credential file over the cap with the cap text, from read and from the entry of withKey', async () => {
    const directory = path.join(makeTemporaryDirectory(), 'creds');
    const store = createFileCredentialStore(directory);
    await store.write('k', 'small', SIGNAL);
    const file = credentialFileFor(directory, 'k');
    fs.writeFileSync(file, 'x'.repeat(AUTH_DOCUMENT_MAX_BYTES + 1), { mode: 0o600 });
    const text = `credential file ${file} is larger than ${AUTH_DOCUMENT_MAX_BYTES} bytes`;
    await expect(store.read('k', SIGNAL)).rejects.toThrow(text);
    await expect(store.withKey('k', (entry) => entry.read(), SIGNAL)).rejects.toThrow(text);
  });

  it('reads a credential file of exactly the cap in full', async () => {
    const directory = path.join(makeTemporaryDirectory(), 'creds');
    const store = createFileCredentialStore(directory);
    const value = 'x'.repeat(AUTH_DOCUMENT_MAX_BYTES);
    await store.write('k', value, SIGNAL);
    expect(await store.read('k', SIGNAL)).toBe(value);
  });
});
