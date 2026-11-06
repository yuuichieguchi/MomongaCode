import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { momongaPaths } from '@momonga/foundation';
import { protectedRootAreasOf } from '@momonga/runtime';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

const tempHome = (): string => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'momonga-areas-')));
  homes.push(home);
  return home;
};

describe('protectedRootAreasOf and the executables area that holds every extracted product executable', () => {
  it('lists <cacheBase>/executables, so that no session root lies inside it', () => {
    const home = tempHome();
    const paths = momongaPaths(home, process.platform, {});
    expect(protectedRootAreasOf(paths, home)).toContain(path.join(paths.cacheBase, 'executables'));
  });

  it('keeps the momonga root, the keychains and the tmp root listed', () => {
    const home = tempHome();
    const paths = momongaPaths(home, process.platform, {});
    const areas = protectedRootAreasOf(paths, home);
    expect(areas).toContain(path.join(home, '.momonga'));
    expect(areas).toContain(paths.keychains);
    expect(areas).toContain(paths.tmp.root);
  });

  it('does not list the whole cache base, which holds the writable tmp area', () => {
    const home = tempHome();
    const paths = momongaPaths(home, process.platform, {});
    expect(protectedRootAreasOf(paths, home)).not.toContain(paths.cacheBase);
  });
});
