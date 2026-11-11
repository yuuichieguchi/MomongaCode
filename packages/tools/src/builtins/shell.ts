import fs from 'node:fs';
import type { ShellHost, ShellPorts } from '@momonga/policy';

export const nodeShellPorts = (): ShellPorts => ({
  isExecutable: (file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
  env: process.env,
});

export const nodeShellHost = (): ShellHost => ({ platform: process.platform, isExecutable: nodeShellPorts().isExecutable });
