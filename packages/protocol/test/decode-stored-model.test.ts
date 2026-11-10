import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { PROPERTY_TIMEOUT_MS } from '@momonga/testkit';
import { STORED_MODEL_KEYS, decodeStoredModel } from '../src/index.ts';
import type { StoredModelRef } from '../src/index.ts';
import { seeded } from '../../context/test/helpers.ts';

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });

const KEYS = { current: 'model', legacy: 'modelAlias' };

const VALUES: readonly unknown[] = ['ollama/x:latest', 'local', '', 7, true, null, ['a'], { a: 1 }, undefined];

const recordOf = (random: ReturnType<typeof seeded>): Record<string, unknown> => {
  const record: Record<string, unknown> = {};
  if (random.int(0, 3) > 0) record['model'] = VALUES[random.int(0, VALUES.length - 1)];
  if (random.int(0, 3) > 0) record['modelAlias'] = VALUES[random.int(0, VALUES.length - 1)];
  if (random.int(0, 1) === 1) record['other'] = VALUES[random.int(0, VALUES.length - 1)];
  return record;
};

const expectedOf = (record: Record<string, unknown>): string | undefined => {
  if (typeof record['model'] === 'string') return record['model'];
  if (typeof record['modelAlias'] === 'string') return record['modelAlias'];
  return undefined;
};

describe('decodeStoredModel reads a stored model field of this build and of an earlier one', () => {
  it('the current key gives its value', () => {
    expect(decodeStoredModel({ model: 'ollama/x:latest' }, KEYS)).toBe('ollama/x:latest');
  });

  it('only the key of an earlier build gives its value', () => {
    expect(decodeStoredModel({ modelAlias: 'fast' }, KEYS)).toBe('fast');
  });

  it('both keys give the current one', () => {
    expect(decodeStoredModel({ model: 'ollama/x:latest', modelAlias: 'fast' }, KEYS)).toBe('ollama/x:latest');
  });

  it('neither key gives nothing', () => {
    expect(decodeStoredModel({ other: 'x' }, KEYS)).toBeUndefined();
  });

  it('a current key that holds no string falls to the string under the earlier key', () => {
    expect(decodeStoredModel({ model: 7, modelAlias: 'fast' }, KEYS)).toBe('fast');
  });

  it('a text of an earlier build is returned unchanged as a stored reference', () => {
    const decoded = decodeStoredModel({ modelAlias: 'local' }, KEYS);
    expect(decoded).toBe('local');
    expectTypeOf(decoded).toEqualTypeOf<StoredModelRef | undefined>();
  });

  it(
    'is total: for 200 generated records it returns a string or nothing and never throws',
    () => {
      for (let seed = 1; seed <= 200; seed += 1) {
        const record = recordOf(seeded(seed));
        const decoded = decodeStoredModel(record, KEYS);
        expect(decoded === undefined || typeof decoded === 'string', `seed ${seed}`).toBe(true);
        expect(decoded, `seed ${seed}`).toBe(expectedOf(record));
      }
    },
  );

  it('the classifier event reads the key of an earlier build through STORED_MODEL_KEYS.classified', () => {
    expect(STORED_MODEL_KEYS).toEqual({
      modelChanged: { current: 'model', legacy: 'modelAlias' },
      previousModel: { current: 'previousModel', legacy: 'previousModelAlias' },
      pin: { current: 'model', legacy: 'modelAlias' },
      classified: { current: 'model', legacy: 'alias' },
    });
    expect(decodeStoredModel({ alias: 'local' }, STORED_MODEL_KEYS.classified)).toBe('local');
    expect(decodeStoredModel({ model: 'ollama/x:latest', alias: 'local' }, STORED_MODEL_KEYS.classified)).toBe('ollama/x:latest');
    expect(decodeStoredModel({}, STORED_MODEL_KEYS.classified)).toBeUndefined();
  });
});
