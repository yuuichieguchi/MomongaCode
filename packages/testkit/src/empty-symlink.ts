import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const supportsEmptySymlink = (): boolean => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-empty-link-'));
  try {
    fs.symlinkSync('', path.join(directory, 'link'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

export const EMPTY_SYMLINK_SUPPORTED = supportsEmptySymlink();
