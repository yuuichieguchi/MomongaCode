import { describe, expect, it } from 'vitest';
import { withTempDir } from '@momonga/testkit';
import { assertFakeHome } from './launcher-fixture.ts';

describe('assertFakeHome', () => {
  it('accepts a home made by withTempDir as a home', (context) => {
    expect(() => assertFakeHome(withTempDir(context, { asHome: true }))).not.toThrow();
  });

  it('accepts a plain temp dir made by withTempDir', (context) => {
    expect(() => assertFakeHome(withTempDir(context))).not.toThrow();
  });

  it('refuses a directory that withTempDir cannot produce', () => {
    expect(() => assertFakeHome('/nonexistent-momonga-home')).toThrow(/temp dir/);
  });
});
