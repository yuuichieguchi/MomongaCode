import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { momongaPaths } from '@momonga/foundation';
import { protectedRootAreasOf } from '@momonga/runtime';
import { createTempDir } from '@momonga/testkit';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const tempHome = (): string => {
  const home = createTempDir();
  homes.push(home);
  return home;
};

describe('protectedRootAreasOf and the executables area that holds every extracted product executable', () => {
  it('lists <cacheBase>/executables, so that no session root lies inside it', () => {
    const home = tempHome();
    const paths = momongaPaths(home, process.platform, {});
    expect(protectedRootAreasOf(paths)).toContain(path.join(paths.cacheBase, 'executables'));
  });

  it('keeps the momonga root, the keychains and the tmp root listed', () => {
    const home = tempHome();
    const paths = momongaPaths(home, process.platform, {});
    const areas = protectedRootAreasOf(paths);
    expect(areas).toContain(path.join(home, '.momonga'));
    expect(areas).toContain(paths.keychains);
    expect(areas).toContain(paths.tmp.root);
  });

  it('does not list the whole cache base, which holds the writable tmp area', () => {
    const home = tempHome();
    const paths = momongaPaths(home, process.platform, {});
    expect(protectedRootAreasOf(paths)).not.toContain(paths.cacheBase);
  });
});
