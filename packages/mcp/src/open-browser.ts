import { execFile } from 'node:child_process';

const OPEN_PROGRAM = '/usr/bin/open';

export const openInBrowser = (url: URL, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      reject(new Error(`opening an authorization URL is only supported on macOS, not ${process.platform}`));
      return;
    }
    execFile(OPEN_PROGRAM, [url.toString()], { signal }, (error) => (error === null ? resolve() : reject(error)));
  });
