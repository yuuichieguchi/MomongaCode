import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeFileSystem } from '@momonga/foundation';
import { createTempDir, fileSystemWithFault, removeTempDir } from '@momonga/testkit';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await removeTempDir(root);
});

const scratch = (): string => {
  const root = createTempDir();
  roots.push(root);
  return root;
};

describe('the fault entry of the file-system port', () => {
  it('fails every write under the faulted folder with the stated errno while the fault holds, and leaves reads and other folders alone', async () => {
    const root = scratch();
    const full = path.join(root, 'full');
    fs.mkdirSync(full);
    fs.writeFileSync(path.join(full, 'kept.txt'), 'kept');
    let holding = true;
    const refused: string[] = [];
    const files = fileSystemWithFault(nodeFileSystem, { code: 'ENOSPC', under: full, holds: () => holding, refused: (file) => refused.push(file) });

    await expect(files.writeFile(path.join(full, 'a.txt'), 'a')).rejects.toMatchObject({ code: 'ENOSPC', path: path.join(full, 'a.txt') });
    await expect(files.mkdir(path.join(full, 'd'))).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(files.open(path.join(full, 'b.txt'), 'w')).rejects.toMatchObject({ code: 'ENOSPC' });
    await expect(files.rename(path.join(full, 'kept.txt'), path.join(full, 'moved.txt'))).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(await files.readTextFile(path.join(full, 'kept.txt'))).toBe('kept');
    await files.writeFile(path.join(root, 'outside.txt'), 'outside');
    expect(fs.readFileSync(path.join(root, 'outside.txt'), 'utf8')).toBe('outside');

    expect(refused).toEqual([path.join(full, 'a.txt'), path.join(full, 'd'), path.join(full, 'b.txt'), path.join(full, 'kept.txt')]);
    holding = false;
    await files.writeFile(path.join(full, 'a.txt'), 'a');
    expect(fs.readFileSync(path.join(full, 'a.txt'), 'utf8')).toBe('a');
  });
});
