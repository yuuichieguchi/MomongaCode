import { findProgramOnPath, findProgramOnPathSync } from './program-search.ts';
import type { ProgramSearchFiles, ProgramSearchFilesSync, SearchEnv } from './program-search.ts';

export type OpenCommand = { file: string; args: readonly string[] };

type Opener = { program: string; argsFor(url: URL): readonly string[] };

const OPENERS: readonly Opener[] = [
  { program: 'xdg-open', argsFor: (url) => [url.toString()] },
  { program: 'open', argsFor: (url) => [url.toString()] },
  { program: 'rundll32', argsFor: (url) => ['url.dll,FileProtocolHandler', url.toString()] },
];

export const URL_OPENER_PROGRAMS: readonly string[] = OPENERS.map((opener) => opener.program);

const OPENED_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

const ONLY_WEB_ADDRESSES = 'only http and https addresses can be opened';

const browserOf = (env: SearchEnv): string | undefined => {
  const browser = env['BROWSER'];
  return browser === undefined || browser === '' ? undefined : browser;
};

const openerOnPath = async (env: SearchEnv, files: ProgramSearchFiles): Promise<{ file: string; opener: Opener } | undefined> => {
  for (const opener of OPENERS) {
    const file = await findProgramOnPath(opener.program, env, files);
    if (file !== undefined) return { file, opener };
  }
  return undefined;
};

export const urlOpenerFileFor = async (env: SearchEnv, files: ProgramSearchFiles): Promise<string | undefined> => browserOf(env) ?? (await openerOnPath(env, files))?.file;

export const urlOpenerFileForSync = (env: SearchEnv, files: ProgramSearchFilesSync): string | undefined =>
  browserOf(env) ?? URL_OPENER_PROGRAMS.map((program) => findProgramOnPathSync(program, env, files)).find((file) => file !== undefined);

export const openCommandFor = async (url: URL, env: SearchEnv, files: ProgramSearchFiles): Promise<OpenCommand> => {
  const browser = browserOf(env);
  if (browser !== undefined) return { file: browser, args: [url.toString()] };
  const found = await openerOnPath(env, files);
  if (found !== undefined) return { file: found.file, args: found.opener.argsFor(url) };
  throw new Error(`no program to open a URL was found on PATH; looked for ${URL_OPENER_PROGRAMS.join(', ')}, and BROWSER is not set`);
};

export type ProgramEnd = { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null };

export type LaunchProgram = (file: string, args: readonly string[]) => Promise<ProgramEnd>;

export type BrowserOpenerPorts = { env: SearchEnv; launch: LaunchProgram; files: ProgramSearchFiles };

export type OpenUrl = (url: URL, watch: AbortSignal, onFailure: (message: string) => void) => void;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const unsuccessfulEndOf = (file: string, end: ProgramEnd): string | undefined => {
  if (end.exitCode === 0) return undefined;
  return end.exitCode === null ? `${file} was ended by signal ${end.signal}` : `${file} exited with code ${end.exitCode}`;
};

const launched = async (ports: BrowserOpenerPorts, url: URL, watch: AbortSignal): Promise<string | undefined> => {
  if (!OPENED_SCHEMES.has(url.protocol)) return ONLY_WEB_ADDRESSES;
  const { file, args } = await openCommandFor(url, ports.env, ports.files);
  if (watch.aborted) return undefined;
  const end = await ports.launch(file, args).catch((error: unknown) => {
    throw new Error(`${file} could not be started: ${messageOf(error)}`);
  });
  return unsuccessfulEndOf(file, end);
};

export const createBrowserOpener =
  (ports: BrowserOpenerPorts): OpenUrl =>
  (url, watch, onFailure) => {
    if (watch.aborted) return;
    const report = (message: string | undefined): void => {
      if (message !== undefined && !watch.aborted) onFailure(message);
    };
    void launched(ports, url, watch).then(report, (error: unknown) => report(messageOf(error)));
  };
