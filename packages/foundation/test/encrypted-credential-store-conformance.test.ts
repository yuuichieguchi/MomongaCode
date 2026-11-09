import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREDENTIAL_KEY_CREATION_STEPS, CREDENTIAL_KEY_MARKER_FILE, createEncryptedCredentialStore } from '@momonga/foundation';
import { createFakeKeyStore, recordFileOf } from './support/credential-key-fakes.ts';
import { makeTemporaryDirectory as makeDir } from './support/temporary-directory.ts';

const MODEL_STEP_OF_EVENT: Readonly<Record<string, string>> = {
  marker_absent_at_os_write: 'read_marker_again',
  os_item_written: 'write_os_item',
  marker_present_at_record: 'write_marker',
};

describe('encrypted credential store conforms to CredentialKey.tla (Reread, Creating os, Creating marker, Rec)', () => {
  it('names the creation steps of the model in its order', () => {
    expect(CREDENTIAL_KEY_CREATION_STEPS).toEqual(['read_marker_again', 'write_os_item', 'write_marker']);
  });

  it('creates the key in the model order: no marker and no record at the OS-store write, the marker before the record', async () => {
    const home = makeDir();
    const stateDirectory = path.join(home, 'state');
    const directory = path.join(stateDirectory, 'plan-sessions');
    const markerFile = path.join(stateDirectory, CREDENTIAL_KEY_MARKER_FILE);
    const recordFile = recordFileOf(directory, 'plan/p/a');
    const events: string[] = [];
    const keys = createFakeKeyStore();
    keys.onWrite = () => {
      if (!fs.existsSync(markerFile)) events.push('marker_absent_at_os_write');
      if (!fs.existsSync(recordFile)) events.push('os_item_written');
    };
    const store = createEncryptedCredentialStore({
      directory,
      stateDirectory,
      secretStore: { kind: 'available', store: keys },
      plaintextTokenFiles: () => false,
    });
    await store.write('plan/p/a', 'token');
    expect(fs.existsSync(markerFile)).toBe(true);
    expect(fs.statSync(markerFile).mtimeMs).toBeLessThanOrEqual(fs.statSync(recordFile).mtimeMs);
    events.push('marker_present_at_record');
    expect(events.map((event) => MODEL_STEP_OF_EVENT[event])).toEqual([...CREDENTIAL_KEY_CREATION_STEPS]);
  });

  it('a writer that finds the marker after taking the lock creates nothing (Reread with marker /= 0)', async () => {
    const home = makeDir();
    const stateDirectory = path.join(home, 'state');
    const directory = path.join(stateDirectory, 'plan-sessions');
    const keys = createFakeKeyStore();
    const options = { directory, stateDirectory, secretStore: { kind: 'available' as const, store: keys }, plaintextTokenFiles: () => false };
    const writers = Array.from({ length: 4 }, () => createEncryptedCredentialStore(options));
    await Promise.all(writers.map((writer, index) => writer.write(`plan/p/${index}`, `token-${index}`)));
    expect(keys.writes.filter((name) => name.startsWith('credential-key-'))).toHaveLength(1);
  });
});
