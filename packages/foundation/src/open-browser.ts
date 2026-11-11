import { findProgramOnPath } from './program-search.ts';
import type { SearchEnv } from './program-search.ts';

export type OpenCommand = { file: string; args: readonly string[] };

const OPENERS: readonly { program: string; argsFor(url: URL): readonly string[] }[] = [
  { program: 'xdg-open', argsFor: (url) => [url.toString()] },
  { program: 'open', argsFor: (url) => [url.toString()] },
  { program: 'rundll32', argsFor: (url) => ['url.dll,FileProtocolHandler', url.toString()] },
];

export const URL_OPENER_PROGRAMS: readonly string[] = OPENERS.map((opener) => opener.program);

const browserOf = (env: SearchEnv): string | undefined => {
  const browser = env['BROWSER'];
  return browser === undefined || browser === '' ? undefined : browser;
};

const openerOnPath = (env: SearchEnv): { file: string; argsFor(url: URL): readonly string[] } | undefined => {
  for (const opener of OPENERS) {
    const file = findProgramOnPath(opener.program, env);
    if (file !== undefined) return { file, argsFor: opener.argsFor };
  }
  return undefined;
};

export const urlOpenerFileFor = (env: SearchEnv): string | undefined => browserOf(env) ?? openerOnPath(env)?.file;

export const openCommandFor = (url: URL, env: SearchEnv): OpenCommand => {
  const browser = browserOf(env);
  if (browser !== undefined) return { file: browser, args: [url.toString()] };
  const opener = openerOnPath(env);
  if (opener !== undefined) return { file: opener.file, args: opener.argsFor(url) };
  throw new Error(`no program to open a URL was found on PATH; looked for ${URL_OPENER_PROGRAMS.join(', ')}, and BROWSER is not set`);
};

export type ProgramEnd = { readonly exitCode: number | null; readonly signal: NodeJS.Signals | null };

export type LaunchProgram = (file: string, args: readonly string[]) => Promise<ProgramEnd>;

export type BrowserOpenerPorts = { env: SearchEnv; launch: LaunchProgram };

export type OpenUrl = (url: URL, watch: AbortSignal, onFailure: (message: string) => void) => void;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const unsuccessfulEndOf = (file: string, end: ProgramEnd): string | undefined => {
  if (end.exitCode === 0) return undefined;
  return end.exitCode === null ? `${file} was ended by signal ${end.signal}` : `${file} exited with code ${end.exitCode}`;
};

const commandOrProblem = (url: URL, env: SearchEnv): { command: OpenCommand } | { problem: string } => {
  try {
    return { command: openCommandFor(url, env) };
  } catch (error) {
    return { problem: messageOf(error) };
  }
};

export const createBrowserOpener =
  (ports: BrowserOpenerPorts): OpenUrl =>
  (url, watch, onFailure) => {
    let reported = false;
    const report = (message: string): void => {
      if (reported || watch.aborted) return;
      reported = true;
      onFailure(message);
    };
    const found = commandOrProblem(url, ports.env);
    if ('problem' in found) {
      queueMicrotask(() => report(found.problem));
      return;
    }
    const { file, args } = found.command;
    void ports.launch(file, args).then(
      (end) => {
        const problem = unsuccessfulEndOf(file, end);
        if (problem !== undefined) report(problem);
      },
      (error: unknown) => report(`${file} could not be started: ${messageOf(error)}`),
    );
  };
