import { describe, expect, it } from 'vitest';
import { formatJson } from '@momonga/context';

const USER_COUNT = 40;
const NEEDLE_INDEX = 17;

const userAt = (index: number) => ({ id: index, name: index === NEEDLE_INDEX ? 'needle-owner' : `user-${index}`, role: 'member' });

const listing = {
  total: USER_COUNT,
  users: Array.from({ length: USER_COUNT }, (_unused, index) => userAt(index + 1)),
  meta: { page: 1, cursor: 'c-end' },
};

const RAW = JSON.stringify(listing, null, 2);

describe('the json formatter', () => {
  it('declines an output that is not JSON', () => {
    expect(formatJson('not json at all {', [])).toBeUndefined();
  });

  it('keeps the structure: every key of the document is named', () => {
    const formatted = formatJson(RAW, []) as string;
    for (const key of ['total', 'users', 'meta', 'page', 'cursor', 'id', 'name', 'role']) expect(formatted).toContain(key);
    expect(formatted).toContain('c-end');
  });

  it('renders a homogeneous array of more than one element as its shape and count, dropping the elements that match no term', () => {
    const formatted = formatJson(RAW, []) as string;
    expect(formatted).toMatch(new RegExp(`\\b${USER_COUNT}\\b`));
    expect(formatted).not.toContain('user-23');
    expect(formatted).not.toContain('user-1"');
    expect(formatted.length).toBeLessThan(RAW.length / 4);
  });

  it('keeps the elements of a homogeneous array that match a task term', () => {
    const formatted = formatJson(RAW, ['needle-owner']) as string;
    expect(formatted).toContain('needle-owner');
    expect(formatted).not.toContain('user-23');
  });

  it('keeps a one-element array in full', () => {
    const raw = JSON.stringify({ items: [{ sku: 'only-sku-1', qty: 3 }] });
    const formatted = formatJson(raw, []) as string;
    expect(formatted).toContain('only-sku-1');
    expect(formatted).toContain('qty');
  });

  it('keeps every element of an array that is not homogeneous', () => {
    const raw = JSON.stringify({ mixed: [7, 'tag-alpha', { inner: 'deep-beta' }] });
    const formatted = formatJson(raw, []) as string;
    expect(formatted).toContain('tag-alpha');
    expect(formatted).toContain('deep-beta');
    expect(formatted).toMatch(/\b7\b/);
  });
});
