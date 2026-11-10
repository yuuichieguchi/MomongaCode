import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createEncryptedCredentialStore, createMemoryCredentialStore, credentialFileFor } from '@momonga/foundation';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { createFakeKeyStore } from './support/credential-key-fakes.ts';
import { makeTemporaryDirectory } from './support/temporary-directory.ts';
import { seededRandom } from './seeded-random.ts';
import type { Random } from './seeded-random.ts';

vi.setConfig({ testTimeout: REAL_PROCESS_TEST_TIMEOUT_MS });

type Listing = { keys: { key: string; file: string }[]; problems: { file: string; cause: string }[] };

type Listable = { listKeys(): Promise<Listing> };

const RUNS = 25;

const KEY_OF_PLAINTEXT = (text: string): string => {
  const parsed = JSON.parse(text) as { profile: string; account: string };
  return `plan/${parsed.profile}/${parsed.account}`;
};

const listableOf = (store: unknown): Listable => store as Listable;

const keyFor = (index: number): string => `plan/p${index % 3}/a-${index}`;

const recordFor = (key: string): string => {
  const [, profile, account] = key.split('/');
  return JSON.stringify({ profile, account, secret: `value-${account}` });
};

type Case = { written: string[]; loose: string[]; copied: string[]; garbage: string[]; temporaries: string[]; plaintext: boolean };

const caseOf = (random: Random): Case => {
  const written = [...new Set(Array.from({ length: random.int(0, 6) }, () => keyFor(random.int(0, 40))))];
  const loose = written.filter(() => random.int(0, 4) === 0);
  const healthy = written.filter((key) => !loose.includes(key));
  const copied = healthy.length === 0 || random.int(0, 2) !== 0 ? [] : [random.pick(healthy)];
  const garbage = random.int(0, 3) === 0 ? ['plan/x/garbage'] : [];
  const temporaries = Array.from({ length: random.int(0, 2) }, (_, index) => `left-${index}.tmp`);
  return { written, loose, copied, garbage, temporaries, plaintext: random.int(0, 1) === 1 };
};

const nameOf = (file: string): string => path.basename(file);

describe('listKeys of the encrypted store equals the set of records created (O-R5-6 D)', () => {
  it('over crash-left temporaries, copied files, files that are not JSON and loose modes', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const random = seededRandom(seed);
      const given = caseOf(random);
      const home = makeTemporaryDirectory();
      const directory = path.join(home, 'state', 'plan-sessions');
      const store = createEncryptedCredentialStore({
        directory,
        stateDirectory: path.join(home, 'state'),
        secretStore: { kind: 'available', store: createFakeKeyStore() },
        plaintextTokenFiles: () => given.plaintext,
        keyOfPlaintext: KEY_OF_PLAINTEXT,
      } as Parameters<typeof createEncryptedCredentialStore>[0]);
      for (const key of given.written) await store.write(key, recordFor(key));
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const key of given.loose) fs.chmodSync(credentialFileFor(directory, key), 0o644);
      const copies = given.copied.map((key, index) => {
        const copy = credentialFileFor(directory, `plan/copy/${index}`);
        fs.copyFileSync(credentialFileFor(directory, key), copy);
        fs.chmodSync(copy, 0o600);
        return copy;
      });
      const garbage = given.garbage.map((key) => {
        const file = credentialFileFor(directory, key);
        fs.writeFileSync(file, 'not json', { mode: 0o600 });
        return file;
      });
      for (const name of given.temporaries) fs.writeFileSync(path.join(directory, name), 'partial', { mode: 0o600 });

      const listing = await listableOf(store).listKeys();

      const expectedKeys = given.written.filter((key) => !given.loose.includes(key)).sort();
      expect(listing.keys.map((entry) => entry.key).sort(), `seed ${seed}`).toEqual(expectedKeys);
      for (const entry of listing.keys) expect(nameOf(entry.file), `seed ${seed}`).toBe(nameOf(credentialFileFor(directory, entry.key)));
      const expectedProblems = [...given.loose.map((key) => credentialFileFor(directory, key)), ...copies, ...garbage].map(nameOf).sort();
      expect(listing.problems.map((problem) => nameOf(problem.file)).sort(), `seed ${seed}`).toEqual(expectedProblems);
      for (const problem of listing.problems) expect(problem.cause.length, `seed ${seed}`).toBeGreaterThan(0);
    }
  });

  it('a plaintext file is a problem when the owner passed no keyOfPlaintext', async () => {
    const home = makeTemporaryDirectory();
    const directory = path.join(home, 'state', 'plan-sessions');
    const store = createEncryptedCredentialStore({
      directory,
      stateDirectory: path.join(home, 'state'),
      secretStore: { kind: 'available', store: createFakeKeyStore() },
      plaintextTokenFiles: () => true,
    });
    await store.write('plan/p/a', recordFor('plan/p/a'));
    const listing = await listableOf(store).listKeys();
    expect(listing.keys).toEqual([]);
    expect(listing.problems.map((problem) => nameOf(problem.file))).toEqual([nameOf(credentialFileFor(directory, 'plan/p/a'))]);
  });

  it('an empty directory lists nothing', async () => {
    const home = makeTemporaryDirectory();
    fs.mkdirSync(path.join(home, 'state', 'plan-sessions'), { recursive: true, mode: 0o700 });
    const store = createEncryptedCredentialStore({
      directory: path.join(home, 'state', 'plan-sessions'),
      stateDirectory: path.join(home, 'state'),
      secretStore: { kind: 'available', store: createFakeKeyStore() },
      plaintextTokenFiles: () => false,
    });
    expect(await listableOf(store).listKeys()).toEqual({ keys: [], problems: [] });
  });
});

describe('listKeys of the memory store returns exactly the keys it holds (O-R5-6 D)', () => {
  it('lists what was written and not removed, with the key as the file', async () => {
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const random = seededRandom(seed);
      const store = createMemoryCredentialStore();
      const held = new Set<string>();
      for (let step = 0; step < 12; step += 1) {
        const key = keyFor(random.int(0, 8));
        if (random.int(0, 2) === 0) {
          await store.remove(key);
          held.delete(key);
        } else {
          await store.write(key, recordFor(key));
          held.add(key);
        }
      }
      const listing = await listableOf(store).listKeys();
      expect(
        [...listing.keys].sort((a, b) => a.key.localeCompare(b.key)),
        `seed ${seed}`,
      ).toEqual([...held].sort().map((key) => ({ key, file: key })));
      expect(listing.problems).toEqual([]);
    }
  });
});
