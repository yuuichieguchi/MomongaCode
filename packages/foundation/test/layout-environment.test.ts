import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { homeLayout, momongaLayout, momongaPaths } from '../src/momonga-paths.ts';

const HOME = '/home/someone';

describe('one set of inputs names a product directory in every process', () => {
  it('the cache base follows XDG_CACHE_HOME, and every directory under it follows the cache base', () => {
    const paths = momongaLayout(HOME, 'linux', { XDG_CACHE_HOME: '/x' });
    expect(paths.cacheBase).toBe('/x/momonga');
    expect(paths.executables).toBe('/x/momonga/executables');
    expect(paths.tmp).toEqual({ root: '/x/momonga/tmp', spawn: '/x/momonga/tmp/spawn', sessions: '/x/momonga/tmp/sessions' });
  });

  it('without the variable the cache base lies under the home', () => {
    expect(momongaLayout(HOME, 'linux', {}).cacheBase).toBe('/home/someone/.cache/momonga');
    expect(momongaPaths(HOME, 'linux', {}).cacheBase).toBe('/home/someone/.cache/momonga');
  });

  it('the key store follows XDG_DATA_HOME', () => {
    expect(momongaLayout(HOME, 'linux', { XDG_DATA_HOME: '/data' }).keychains).toBe('/data/keyrings');
  });

  it('the part of the layout under the home needs no environment and is the same part of the whole layout', () => {
    const whole = momongaLayout(HOME, 'linux', { XDG_CACHE_HOME: '/x', XDG_DATA_HOME: '/data' });
    const { keychains: _keychains, cacheBase: _cacheBase, executables: _executables, tmp: _tmp, ...underHome } = whole;
    expect(homeLayout(HOME, 'linux')).toEqual(underHome);
    for (const value of Object.values(homeLayout(HOME, 'linux')).filter((entry) => typeof entry === 'string')) {
      expect(value === HOME || value.startsWith(`${HOME}${path.posix.sep}`)).toBe(true);
    }
  });

  it('a layout without its environment does not compile', () => {
    // @ts-expect-error the environment of the layout has no default
    expect(() => momongaLayout(HOME, 'linux')).toThrow(TypeError);
    // @ts-expect-error the environment of the layout has no default
    expect(() => momongaPaths(HOME, 'linux')).toThrow(TypeError);
    // @ts-expect-error the platform and the environment of the layout have no default
    expect(() => momongaPaths(HOME)).toThrow(TypeError);
  });
});
