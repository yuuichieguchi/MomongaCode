import fs from 'node:fs';
import path from 'node:path';

const restoreModes = (directory: string): void => {
  let entries: fs.Dirent[];
  try {
    fs.chmodSync(directory, 0o700);
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) restoreModes(path.join(directory, entry.name));
  }
};

export const removeTree = (directory: string): void => {
  restoreModes(directory);
  fs.rmSync(directory, { recursive: true, force: true });
};
