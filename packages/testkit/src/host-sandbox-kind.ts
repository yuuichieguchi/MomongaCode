import fs from 'node:fs';

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

const launcherExecutable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};

export const HOST_SANDBOX_KIND: 'seatbelt' | 'bubblewrap' = launcherExecutable(SANDBOX_EXEC_PATH) ? 'seatbelt' : 'bubblewrap';
