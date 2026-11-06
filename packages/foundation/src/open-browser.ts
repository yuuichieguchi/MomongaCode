import { findProgramOnPath } from './program-search.ts';
import type { SearchEnv } from './program-search.ts';

export type OpenCommand = { file: string; args: readonly string[] };

const OPENERS: readonly { program: string; argsFor(url: URL): readonly string[] }[] = [
  { program: 'xdg-open', argsFor: (url) => [url.toString()] },
  { program: 'open', argsFor: (url) => [url.toString()] },
  { program: 'rundll32', argsFor: (url) => ['url.dll,FileProtocolHandler', url.toString()] },
];

export const openCommandFor = (url: URL, env: SearchEnv): OpenCommand => {
  const browser = env['BROWSER'];
  if (browser !== undefined && browser !== '') return { file: browser, args: [url.toString()] };
  for (const opener of OPENERS) {
    const file = findProgramOnPath(opener.program, env);
    if (file !== undefined) return { file, args: opener.argsFor(url) };
  }
  throw new Error(`no program to open a URL was found on PATH; looked for ${OPENERS.map((opener) => opener.program).join(', ')}, and BROWSER is not set`);
};

export type BrowserRunPort = (file: string, args: readonly string[], signal: AbortSignal) => Promise<{ exitCode: number }>;

export type BrowserOpenerPorts = { env: SearchEnv; print(text: string): void; run: BrowserRunPort };

export const createBrowserOpener =
  (ports: BrowserOpenerPorts): ((url: URL, signal: AbortSignal) => Promise<void>) =>
  async (url, signal) => {
    ports.print(`Open this URL in your browser: ${url.toString()}`);
    let command: OpenCommand;
    try {
      command = openCommandFor(url, ports.env);
    } catch (error) {
      ports.print(`The browser could not be opened: ${(error as Error).message}`);
      return;
    }
    try {
      const { exitCode } = await ports.run(command.file, command.args, signal);
      if (exitCode !== 0) ports.print(`The browser could not be opened: ${command.file} exited with ${exitCode}`);
    } catch (error) {
      ports.print(`The browser could not be opened: ${command.file} failed: ${(error as Error).message}`);
    }
  };
