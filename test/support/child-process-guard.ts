import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { findProgramOnPath } from '@momonga/foundation/program-search';
import { SECRET_STORE_SEARCHED_PROGRAMS, credentialReadScript, credentialWriteScript } from '@momonga/foundation/secret-store';
import { MOMONGA_LAUNCHES } from '../../packages/cli/src/daemon/launcher.ts';
import { URL_OPENER_PROGRAMS, urlOpenerFileFor } from '../../packages/foundation/src/open-browser.ts';
import { chosenSecretProgramOutsideFakes, givenSecretProgramOutsideFakes, isInsideFakeSecretPrograms, realFileOf } from '../../packages/testkit/src/secret-store-env-check.ts';

const LAUNCHERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
type LauncherName = (typeof LAUNCHERS)[number];

type Launch = (...args: unknown[]) => unknown;
type ProcessEnv = Readonly<Record<string, string | undefined>>;
type LaunchOptions = { env?: ProcessEnv; shell?: unknown; cwd?: unknown };

const GUARDED = Symbol.for('momonga.childProcessGuard');

const optionsOf = (args: readonly unknown[]): LaunchOptions =>
  (args.slice(1).find((arg) => typeof arg === 'object' && arg !== null && !Array.isArray(arg)) as LaunchOptions | undefined) ?? {};

const argvOf = (args: readonly unknown[]): string[] => (Array.isArray(args[1]) ? args[1].map(String) : []);

const SHELL_WORD_BREAKS: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r', ';', '&', '|', '(', ')', '<', '>', '`']);

const closingParenthesisOf = (text: string, start: number): number => {
  let depth = 1;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    if (text[index] === ')') depth -= 1;
    if (depth === 0) return index;
  }
  return text.length;
};

const closingBackquoteOf = (text: string, start: number): number => {
  const end = text.indexOf('`', start);
  return end === -1 ? text.length : end;
};

export const shellWordsOf = (text: string): string[] => {
  const words: string[] = [];
  let word: string | undefined;
  const endWord = (): void => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  let index = 0;
  const substitutionEnd = (): number | undefined => {
    if (text[index] === '`') return closingBackquoteOf(text, index + 1);
    if (text[index] === '$' && text[index + 1] === '(') return closingParenthesisOf(text, index + 2);
    return undefined;
  };
  const readDoubleQuoted = (): void => {
    word ??= '';
    while (index < text.length && text[index] !== '"') {
      const end = substitutionEnd();
      if (end !== undefined) {
        words.push(...shellWordsOf(text.slice(index + (text[index] === '`' ? 1 : 2), end)));
        index = end + 1;
      } else if (text[index] === '\\' && index + 1 < text.length) {
        word += text[index + 1];
        index += 2;
      } else {
        word += text[index];
        index += 1;
      }
    }
    index += 1;
  };
  while (index < text.length) {
    const character = text[index] as string;
    if (character === "'") {
      const end = text.indexOf("'", index + 1);
      word = (word ?? '') + text.slice(index + 1, end === -1 ? text.length : end);
      index = end === -1 ? text.length : end + 1;
    } else if (character === '"') {
      index += 1;
      readDoubleQuoted();
    } else if (character === '\\' && index + 1 < text.length) {
      word = (word ?? '') + text[index + 1];
      index += 2;
    } else if (SHELL_WORD_BREAKS.has(character)) {
      endWord();
      index += 1;
    } else {
      word = (word ?? '') + character;
      index += 1;
    }
  }
  endWord();
  return words;
};

const SHELL_COMMAND_FLAG = /^-[A-Za-z]*c$/;

const withShellCommandWords = (words: readonly string[]): string[] => words.flatMap((word, index) => (index > 0 && SHELL_COMMAND_FLAG.test(words[index - 1] as string) ? [word, ...withShellCommandWords(shellWordsOf(word))] : [word]));

type LaunchWords = { readonly command: string | undefined; readonly later: readonly string[] };

const launchWordsOf = (name: LauncherName, args: readonly unknown[], options: LaunchOptions): LaunchWords => {
  if (name === 'fork' || typeof args[0] !== 'string') return { command: undefined, later: [] };
  const argv = argvOf(args);
  if (name === 'exec' || name === 'execSync' || (options.shell !== undefined && options.shell !== false)) {
    const [command, ...later] = withShellCommandWords(shellWordsOf([args[0], ...argv].join(' ')));
    return { command, later };
  }
  return { command: args[0], later: withShellCommandWords(argv) };
};

const EXECVP_DEFAULT_PATH = '/usr/bin:/bin';

const SECRET_PROGRAM_NAMES: ReadonlySet<string> = new Set(SECRET_STORE_SEARCHED_PROGRAMS);

const isPathLike = (word: string): boolean => word.includes('/') || word.includes('\\');

const hasSecretProgramName = (fileName: string): boolean => SECRET_PROGRAM_NAMES.has(fileName) || SECRET_PROGRAM_NAMES.has(fileName.replace(/\.[^.]+$/, ''));

const resolvedCommand = (command: string, env: ProcessEnv, cwd: unknown): string | undefined => {
  if (isPathLike(command)) return path.resolve(typeof cwd === 'string' ? cwd : process.cwd(), command);
  return findProgramOnPath(command, env['PATH'] === undefined ? { ...env, PATH: EXECVP_DEFAULT_PATH } : env);
};

const NOT_A_FILE_NAME: ReadonlySet<string> = new Set(['ENAMETOOLONG', 'EINVAL', 'ERR_INVALID_ARG_VALUE']);

const realFileOfWord = (file: string): string | undefined => {
  try {
    const real = realFileOf(file);
    return real !== undefined && fs.statSync(real).isFile() ? real : undefined;
  } catch (error) {
    if (NOT_A_FILE_NAME.has(String((error as NodeJS.ErrnoException).code))) return undefined;
    throw error;
  }
};

const realFileStartedBy = (command: string | undefined, env: ProcessEnv, cwd: unknown): string | undefined => {
  if (command === undefined || command === '') return undefined;
  const found = resolvedCommand(command, env, cwd);
  return found === undefined ? undefined : realFileOfWord(found);
};

const realSecretProgram = (command: string | undefined, env: ProcessEnv, cwd: unknown): string | undefined => {
  const real = realFileStartedBy(command, env, cwd);
  if (real === undefined) return undefined;
  return hasSecretProgramName(path.basename(real)) && !isInsideFakeSecretPrograms(real) ? real : undefined;
};

const URL_OPENER_NAMES: ReadonlySet<string> = new Set(URL_OPENER_PROGRAMS);

const hasUrlOpenerName = (fileName: string): boolean => URL_OPENER_NAMES.has(fileName) || URL_OPENER_NAMES.has(fileName.replace(/\.[^.]+$/, ''));

const realUrlOpener = (command: string | undefined, env: ProcessEnv, cwd: unknown): string | undefined => {
  const real = realFileStartedBy(command, env, cwd);
  if (real === undefined) return undefined;
  return hasUrlOpenerName(path.basename(real)) && !isInsideFakeSecretPrograms(real) ? real : undefined;
};

const browserOutsideFakes = (env: ProcessEnv, cwd: unknown): string | undefined => {
  const browser = env['BROWSER'];
  if (browser === undefined || browser === '') return undefined;
  return isInsideFakeSecretPrograms(resolvedCommand(browser, env, cwd) ?? browser) ? undefined : browser;
};

const inheritedOpenerOutsideFakes = (): string | undefined => {
  const opener = urlOpenerFileFor(process.env);
  return opener === undefined || isInsideFakeSecretPrograms(opener) ? undefined : opener;
};

const realSecretProgramAmong = ({ command, later }: LaunchWords, env: ProcessEnv, cwd: unknown): string | undefined => {
  const started = realSecretProgram(command, env, cwd);
  if (started !== undefined) return started;
  for (const word of new Set(later)) {
    const program = isPathLike(word) || hasSecretProgramName(word) ? realSecretProgram(word, env, cwd) : undefined;
    if (program !== undefined) return program;
  }
  return undefined;
};

const CREDENTIAL_MANAGER_CALLS: readonly string[] = [credentialReadScript(''), credentialWriteScript('', '')].flatMap((script) => script.split('\n').filter((line) => line.includes('DllImport')));

const carriesCredentialManagerScript = (text: string): boolean => CREDENTIAL_MANAGER_CALLS.some((call) => text.includes(call));

const launchCarriesCredentialManagerScript = (args: readonly unknown[]): boolean =>
  [String(args[0]), ...argvOf(args)].some((word) => carriesCredentialManagerScript(word) || carriesCredentialManagerScript(Buffer.from(word, 'base64').toString('utf16le')));

const STORE_CHOOSING_LAUNCHES: ReadonlyArray<readonly string[]> = Object.values(MOMONGA_LAUNCHES)
  .filter((launch) => launch.choosesSecretStoreFromPath)
  .map((launch) => launch.args);

const startsWith = (words: readonly string[], args: readonly string[]): boolean => args.every((arg, index) => words[index] === arg);

const storeChoosingLaunch = (name: LauncherName, args: readonly unknown[]): string | undefined => {
  const argv = name === 'exec' || name === 'execSync' ? String(args[0]).trim().split(/\s+/).slice(1) : argvOf(args);
  return STORE_CHOOSING_LAUNCHES.find((launch) => startsWith(argv, launch) || startsWith(argv.slice(1), launch))?.join(' ');
};

export const launchRefusal = (name: LauncherName, args: readonly unknown[]): string | undefined => {
  const options = optionsOf(args);
  const env = options.env ?? process.env;
  const command = String(args[0]);
  const words = launchWordsOf(name, args, options);
  const program = realSecretProgramAmong(words, env, options.cwd);
  if (program !== undefined) return `refused to launch ${command}: (i) it is the real secret store program ${program}, outside the fake directory`;
  if (launchCarriesCredentialManagerScript(args)) return `refused to launch ${command}: (iv) it carries the Credential Manager script of the product, and no fake of the Credential Manager exists`;
  const given = givenSecretProgramOutsideFakes(env);
  if (given !== undefined) return `refused to launch ${command}: (ii) its environment gives MOMONGA_SECRET_PROGRAM=${given}, outside the fake directory`;
  const selfLaunch = storeChoosingLaunch(name, args);
  if (selfLaunch !== undefined) {
    const chosen = chosenSecretProgramOutsideFakes(env);
    if (chosen !== undefined) return `refused to launch ${command}: (iii) it is the product launch of a MomongaCode binary with ${selfLaunch}, which would choose the secret store ${chosen} from its PATH, outside the fake directory`;
  }
  const opener = realUrlOpener(words.command, env, options.cwd);
  if (opener !== undefined) return `refused to launch ${command}: (v) it is the real program that opens a URL ${opener}, outside the fake directory`;
  const browser = browserOutsideFakes(env, options.cwd);
  if (browser !== undefined) return `refused to launch ${command}: (vi) its environment gives BROWSER=${browser}, outside the fake directory`;
  const inherited = options.env === undefined ? inheritedOpenerOutsideFakes() : undefined;
  if (inherited !== undefined) return `refused to launch ${command}: (vii) it inherits the environment of the test process, in which the product would open a URL with ${inherited}, outside the fake directory`;
  return undefined;
};

const childProcess = createRequire(import.meta.url)('node:child_process') as Record<string, unknown>;

const checked = (name: LauncherName, launch: Launch): Launch =>
  function checkedLaunch(this: unknown, ...args: unknown[]): unknown {
    const refusal = launchRefusal(name, args);
    if (refusal !== undefined) throw new Error(refusal);
    return launch.apply(this, args);
  };

for (const name of LAUNCHERS) {
  const original = childProcess[name] as Launch & { [GUARDED]?: true };
  if (original[GUARDED] === true) continue;
  const guarded = checked(name, original);
  for (const key of Reflect.ownKeys(original)) {
    if (key === 'length' || key === 'name' || key === 'prototype') continue;
    const descriptor = Object.getOwnPropertyDescriptor(original, key) as PropertyDescriptor;
    Object.defineProperty(guarded, key, key === promisify.custom ? { ...descriptor, value: checked(name, descriptor.value as Launch) } : descriptor);
  }
  Object.defineProperty(guarded, GUARDED, { value: true });
  childProcess[name] = guarded;
}
syncBuiltinESMExports();
