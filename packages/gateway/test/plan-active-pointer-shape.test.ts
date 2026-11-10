import { describe, expect, it } from 'vitest';
import { SECRET_NAME_PATTERN, nodeFileSystem } from '@momonga/foundation';
import type { FileSystem } from '@momonga/foundation';
import { readActivePointer } from '../src/plan/active-account.ts';

const FILE = '/state/plan-active.json';

const PROFILE_KEY = 'zz-profile-key';

const holding = (content: unknown): FileSystem => ({ ...nodeFileSystem, readTextFile: async () => JSON.stringify(content) });

const refusal = async (content: unknown): Promise<string> => {
  try {
    await readActivePointer(holding(content), FILE);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the pointer to be refused');
};

describe('the active pointer reader shapes every account it reads and quotes nothing from the file (K3)', () => {
  it.for([
    { name: 'a number', value: 73_519, shown: '73519' },
    { name: 'an object', value: { nested: 'leaked-nested-value' }, shown: 'leaked-nested-value' },
    { name: 'null', value: null, shown: 'null' },
  ])('an account that is $name is refused as not text', async ({ value, shown }) => {
    const message = await refusal({ [PROFILE_KEY]: value });
    expect(message).toBe(`the active plan account file ${FILE} names an account that is not text`);
    expect(message).not.toContain(shown);
    expect(message).not.toContain(PROFILE_KEY);
  });

  it.for([
    { name: 'a slash', value: 'leaked/label' },
    { name: 'a leading dot', value: '.leaked-label' },
    { name: 'a space', value: 'leaked label' },
    { name: '129 characters', value: 'q'.repeat(129) },
    { name: 'no character', value: '' },
  ])('an account with $name is refused as not matching the pattern', async ({ value }) => {
    const message = await refusal({ [PROFILE_KEY]: value });
    expect(message).toBe(`the active plan account file ${FILE} names an account that does not match ${SECRET_NAME_PATTERN}`);
    if (value !== '') expect(message).not.toContain(value);
    expect(message).not.toContain(PROFILE_KEY);
  });

  it('a refused account among valid ones refuses the whole file', async () => {
    expect(await refusal({ first: 'work', [PROFILE_KEY]: 'leaked/label' })).toBe(`the active plan account file ${FILE} names an account that does not match ${SECRET_NAME_PATTERN}`);
  });

  it('accounts that match the pattern are read unchanged', async () => {
    const longest = `a${'b'.repeat(127)}`;
    expect(await readActivePointer(holding({ chatgpt: 'work', other: 'Home_2.b-c', third: longest }), FILE)).toEqual({ chatgpt: 'work', other: 'Home_2.b-c', third: longest });
  });
});
