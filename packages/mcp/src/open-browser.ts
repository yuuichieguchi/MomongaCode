import { execFile } from 'node:child_process';

export type OpenCommand = { file: string; args: readonly string[] };

export const openCommandFor = (platform: NodeJS.Platform, url: URL, env: Readonly<Record<string, string | undefined>> = process.env): OpenCommand => {
  switch (platform) {
    case 'darwin':
      return { file: '/usr/bin/open', args: [url.toString()] };
    case 'linux':
      return { file: '/usr/bin/xdg-open', args: [url.toString()] };
    case 'win32': {
      const systemRoot = env['SystemRoot'];
      if (systemRoot === undefined) throw new Error('SystemRoot is not set, so rundll32 cannot be located');
      return { file: `${systemRoot}\\System32\\rundll32.exe`, args: ['url.dll,FileProtocolHandler', url.toString()] };
    }
    default:
      throw new Error(`opening an authorization URL is not supported on ${platform}`);
  }
};

export const openInBrowser = (url: URL, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const command = openCommandFor(process.platform, url);
    execFile(command.file, [...command.args], { signal, windowsHide: true }, (error) => (error === null ? resolve() : reject(error)));
  });
