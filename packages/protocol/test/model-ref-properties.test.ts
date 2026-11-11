import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadUserSettings } from '@momonga/config';
import { momongaLayout } from '@momonga/foundation';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { canonOf, displayOf, parseCanon, resolveTypedModelRef, shortOf, typedModelText } from '../src/index.ts';
import { seeded } from '../../context/test/helpers.ts';
import { view } from './model-ref-fixtures.ts';
import type { View } from './model-ref-fixtures.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

type Random = ReturnType<typeof seeded>;

const SEEDS = 200;
const TAG = 'latest';
const NAME_POOL = ['x', 'y', 'a/b', 'google/gemma', '/x', 'x:latest', 'x:7b', 'a/b:latest', 'x:latest:latest', ':latest', 'p1/x', 'example/model:7b'] as const;
const PROVIDER_POOL = ['p1', 'p2', 'ollama', 'lmstudio'] as const;
const PROVIDER_HEAD = 'abcdefghijklmnopqrstuvwxyz';
const PROVIDER_TAIL = `${PROVIDER_HEAD}0123456789._-`;
const NAME_CHARACTERS = 'ABCxyzabc019/:._-';
const CAPABILITIES = { contextWindow: 8192, maxOutputTokens: 1024 };

const pick = <T>(random: Random, items: readonly T[]): T => items[random.int(0, items.length - 1)] as T;

const textOver = (random: Random, alphabet: string, length: number): string => Array.from({ length }, () => alphabet[random.int(0, alphabet.length - 1)] as string).join('');

const providerOf = (random: Random): string =>
  random.int(0, 1) === 0 ? pick(random, PROVIDER_POOL) : `${textOver(random, PROVIDER_HEAD, 1)}${textOver(random, PROVIDER_TAIL, random.int(0, 11))}`;

const ownNameOf = (random: Random): string => (random.int(0, 3) === 0 ? textOver(random, NAME_CHARACTERS, random.int(1, 10)) : pick(random, NAME_POOL));

const hasTag = (ownName: string): boolean => ownName.slice(ownName.lastIndexOf('/') + 1).includes(':');

const normalised = (ownName: string, defaultTag: string | undefined): string => (defaultTag === undefined || hasTag(ownName) ? ownName : `${ownName}:${defaultTag}`);

const expectedShort = (ownName: string, defaultTag: string | undefined): string | undefined => {
  if (defaultTag === undefined) return undefined;
  const colon = ownName.lastIndexOf(':');
  if (colon <= 0) return undefined;
  const tag = ownName.slice(colon + 1);
  return tag === defaultTag ? ownName.slice(0, colon) : undefined;
};

const viewsOf = (random: Random): View[] => {
  const providers = [...new Set(Array.from({ length: random.int(0, 4) }, () => providerOf(random)))];
  return providers.flatMap((provider) => {
    const defaultTag = random.int(0, 1) === 0 ? TAG : undefined;
    const ownNames = [...new Set(Array.from({ length: random.int(0, 4) }, () => normalised(ownNameOf(random), defaultTag)))];
    return ownNames.map((ownName) => view(provider, ownName, defaultTag));
  });
};

type Outcome = { kind: 'found'; canon: string } | { kind: 'ambiguous'; canons: string[] } | { kind: 'not_found' };

const specOutcome = (text: string, views: readonly View[]): Outcome => {
  const byCanon = views.find((entry) => entry.canon === text);
  if (byCanon !== undefined) return { kind: 'found', canon: byCanon.canon };
  const byServerAndShort = views.find((entry) => expectedShort(entry.ownName, entry.defaultTag) !== undefined && `${entry.provider}/${expectedShort(entry.ownName, entry.defaultTag) as string}` === text);
  if (byServerAndShort !== undefined) return { kind: 'found', canon: byServerAndShort.canon };
  const holders = views.filter((entry) => entry.ownName === text || expectedShort(entry.ownName, entry.defaultTag) === text);
  if (holders.length === 1) return { kind: 'found', canon: (holders[0] as View).canon };
  return holders.length === 0 ? { kind: 'not_found' } : { kind: 'ambiguous', canons: holders.map((entry) => entry.canon).sort() };
};

const codeOutcome = (text: string, views: readonly View[]): Outcome => {
  const resolution = resolveTypedModelRef(typedModelText(text), views);
  if (resolution.kind === 'found') return { kind: 'found', canon: resolution.model.canon };
  return resolution.kind === 'not_found' ? { kind: 'not_found' } : { kind: 'ambiguous', canons: resolution.choices.map((choice) => choice.canon).sort() };
};

const textsOf = (random: Random, views: readonly View[]): string[] => [
  ...NAME_POOL,
  ...views.flatMap((entry) => [entry.ownName, entry.canon, expectedShort(entry.ownName, entry.defaultTag) ?? entry.ownName, `${entry.provider}/${expectedShort(entry.ownName, entry.defaultTag) ?? entry.ownName}`]),
  ...Array.from({ length: 4 }, () => ownNameOf(random)),
];

const shuffled = <T>(random: Random, items: readonly T[]): T[] => {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = random.int(0, index);
    [result[index], result[other]] = [result[other] as T, result[index] as T];
  }
  return result;
};

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

type LoadedModels = { models: ReadonlyMap<string, unknown>; chains: ReadonlyMap<string, readonly string[]> };

const newHome = (): string => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-model-ref-')));
  homes.push(home);
  return home;
};

const loadModels = async (home: string, models: unknown): Promise<LoadedModels> => {
  const file = momongaLayout(home, process.platform, process.env).settingsFile;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ models }), { mode: 0o600 });
  return (await loadUserSettings({ home })).settings.models as unknown as LoadedModels;
};

const entriesOf = (ids: readonly string[]): unknown[] => ids.map((id) => ({ id, capabilities: CAPABILITIES }));

const ollamaOf = (ids: readonly string[]): unknown => ({ adapter: 'ollama', baseUrl: 'http://127.0.0.1:11434', models: entriesOf(ids) });

const plainOf = (ids: readonly string[]): unknown => ({ adapter: 'chat-completions', provider: 'plain', baseUrl: 'http://plain.invalid/v1', models: entriesOf(ids) });

describe('model references, for every generated configuration', () => {
  it(
    'I-N1: parsing a canonical reference gives back its two parts, and a short form exists exactly under a default tag',
    () => {
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const random = seeded(seed);
        const provider = providerOf(random);
        const ownName = ownNameOf(random);
        expect(parseCanon(canonOf(provider, ownName)), `seed ${seed}`).toEqual({ provider, ownName });
        expect(shortOf(view(provider, ownName, TAG)), `seed ${seed} ${ownName}`).toBe(expectedShort(ownName, TAG));
        expect(shortOf(view(provider, ownName)), `seed ${seed} ${ownName}`).toBeUndefined();
      }
    },
  );

  it(
    'I-N2: the display name of every model resolves to it, a text with several holders is ambiguous, and a server name with a short form names its model',
    () => {
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const random = seeded(seed);
        const views = viewsOf(random);
        for (const entry of views) {
          const display = displayOf(entry, views);
          expect(resolveTypedModelRef(typedModelText(display), views), `seed ${seed} ${display}`).toEqual({ kind: 'found', model: entry });
          const short = expectedShort(entry.ownName, entry.defaultTag);
          if (short !== undefined) {
            const withServer = `${entry.provider}/${short}`;
            const named = views.find((candidate) => candidate.canon === withServer) ?? entry;
            expect(codeOutcome(withServer, views), `seed ${seed} ${withServer}`).toEqual({ kind: 'found', canon: named.canon });
          }
        }
        for (const text of textsOf(random, views)) expect(codeOutcome(text, views), `seed ${seed} ${text}`).toEqual(specOutcome(text, views));
      }
    },
  );

  it(
    'I-N3: no resolution and no display name depends on the order of servers or of models',
    () => {
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const random = seeded(seed);
        const views = viewsOf(random);
        const reordered = shuffled(random, views);
        for (const entry of views) expect(displayOf(entry, reordered), `seed ${seed} ${entry.canon}`).toBe(displayOf(entry, views));
        for (const text of textsOf(random, views)) expect(codeOutcome(text, reordered), `seed ${seed} ${text}`).toEqual(codeOutcome(text, views));
      }
    },
  );

  it(
    'I-N16: the loader adds the default tag once, leaves tagged ids and other kinds alone, and refuses x beside x:latest',
    async () => {
      const home = newHome();
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const random = seeded(seed);
        const drawn = Array.from({ length: random.int(1, 3) }, () => ownNameOf(random));
        const ids = drawn.filter((id, index) => drawn.findIndex((other) => normalised(other, TAG) === normalised(id, TAG)) === index);
        const expected = [...ids.map((id) => `ollama/${normalised(id, TAG)}`), ...ids.map((id) => `plain/${id}`)];
        const first = await loadModels(home, { connections: [ollamaOf(ids), plainOf(ids)] });
        expect([...first.models.keys()], `seed ${seed}`).toEqual(expected);
        const again = await loadModels(home, { connections: [ollamaOf(ids.map((id) => normalised(id, TAG))), plainOf(ids)] });
        expect([...again.models.keys()], `seed ${seed}`).toEqual(expected);
      }
      const duplicate = loadModels(home, { connections: [ollamaOf(['x', 'x:latest'])] });
      await expect(duplicate).rejects.toThrow('models.connections[0].models[1]: "x:latest" is the same model as "x" at models.connections[0].models[0] (an id without a tag means the tag latest)');
    },
  );

  it(
    'I-N6: the chain of a model starts with it, repeats no model, and holds the fallback models in their first-written order',
    async () => {
      const home = newHome();
      for (let seed = 1; seed <= SEEDS; seed += 1) {
        const random = seeded(seed);
        const canons = Array.from({ length: random.int(1, 5) }, (_unused, index) => `plain/m${index}`);
        const fallback = Array.from({ length: random.int(0, 8) }, () => pick(random, canons));
        const loaded = await loadModels(home, { connections: [plainOf(canons.map((canon) => canon.slice('plain/'.length)))], fallback });
        for (const canon of canons) {
          const chain = loaded.chains.get(canon) as readonly string[];
          expect(chain[0], `seed ${seed}`).toBe(canon);
          expect(new Set(chain).size, `seed ${seed}`).toBe(chain.length);
          expect(chain.every((member) => member === canon || fallback.includes(member)), `seed ${seed}`).toBe(true);
          expect(chain.slice(1), `seed ${seed}`).toEqual([...new Set(fallback)].filter((member) => member !== canon));
        }
      }
    },
  );
});
