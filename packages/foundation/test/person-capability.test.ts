import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { momongaLayout, nodeFileSystem, personCapabilityOf, protectedAreasOf, systemRandom } from '@momonga/foundation';
import { createTempDir, removeTempDir, testKernelLock } from '@momonga/testkit';

const ports = { files: nodeFileSystem, random: systemRandom, lock: testKernelLock() };

describe('the capability of the person', () => {
  it('is one owner-only secret per home inside an area denied to every child', async () => {
    const home = createTempDir({ asHome: true });
    try {
      const [first, second] = await Promise.all([personCapabilityOf(ports, home), personCapabilityOf(ports, home)]);
      expect(first).toMatch(/^[0-9a-f]{32}$/);
      expect(second).toBe(first);
      const file = path.join(home, '.momonga', 'person-capability');
      expect(fs.readFileSync(file, 'utf8')).toBe(first);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(protectedAreasOf(momongaLayout(home, process.platform, {})).some((area) => file.startsWith(`${area}${path.sep}`))).toBe(true);
    } finally {
      await removeTempDir(home);
    }
  });

  it('differs between homes', async () => {
    const one = createTempDir({ asHome: true });
    const two = createTempDir({ asHome: true });
    try {
      expect(await personCapabilityOf(ports, one)).not.toBe(await personCapabilityOf(ports, two));
    } finally {
      await removeTempDir(one);
      await removeTempDir(two);
    }
  });
});
