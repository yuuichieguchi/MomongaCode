import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { findProgramOnPath } from '@momonga/foundation/program-search';
import { SECRET_STORE_SEARCHED_PROGRAMS } from '@momonga/foundation/secret-store';
import { INTERNAL_COMMANDS, SUPERVISED_ROLE_COMMANDS } from '../../packages/cli/src/daemon/launcher.ts';
import { chosenSecretProgramOutsideFakes, givenSecretProgramOutsideFakes, isInsideFakeSecretPrograms } from '../../packages/testkit/src/secret-store-env-check.ts';

const LAUNCHERS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const;
type LauncherName = (typeof LAUNCHERS)[number];

type Launch = (...args: unknown[]) => unknown;
type ProcessEnv = Readonly<Record<string, string | undefined>>;
type LaunchOptions = { env?: ProcessEnv; shell?: unknown; cwd?: unknown };

const GUARDED = Symbol.for('momonga.childProcessGuard');

const optionsOf = (args: readonly unknown[]): LaunchOptions =>
  (args.slice(1).find((arg) => typeof arg === 'object' && arg !== null && !Array.isArray(arg)) as LaunchOptions | undefined) ?? {};

const argvOf = (args: readonly unknown[]): string[] => (Array.isArray(args[1]) ? args[1].map(String) : []);

const firstWord = (command: string): string => {
  const quoted = /^\s*(["'])(.*?)\1/.exec(command);
  if (quoted !== null) return quoted[2] as string;
  return command.trim().split(/\s+/)[0] ?? '';
};

const commandOf = (name: LauncherName, args: readonly unknown[], options: LaunchOptions): string | undefined => {
  if (name === 'fork' || typeof args[0] !== 'string') return undefined;
  if (name === 'exec' || name === 'execSync' || (options.shell !== undefined && options.shell !== false)) return firstWord(args[0]);
  return args[0];
};

const EXECVP_DEFAULT_PATH = '/usr/bin:/bin';

const SECRET_PROGRAM_NAMES: ReadonlySet<string> = new Set(SECRET_STORE_SEARCHED_PROGRAMS);

const resolvedCommand = (command: string, env: ProcessEnv, cwd: unknown): string | undefined => {
  if (command.includes('/') || command.includes('\\')) return path.resolve(typeof cwd === 'string' ? cwd : process.cwd(), command);
  return findProgramOnPath(command, env['PATH'] === undefined ? { ...env, PATH: EXECVP_DEFAULT_PATH } : env);
};

const realSecretProgram = (command: string | undefined, env: ProcessEnv, cwd: unknown): string | undefined => {
  if (command === undefined || command === '') return undefined;
  const resolved = resolvedCommand(command, env, cwd);
  if (resolved === undefined) return undefined;
  const programName = path.basename(resolved).replace(/\.[^.]+$/, '');
  const named = SECRET_PROGRAM_NAMES.has(path.basename(resolved)) || SECRET_PROGRAM_NAMES.has(programName);
  return named && !isInsideFakeSecretPrograms(resolved) ? resolved : undefined;
};

const GIVEN_STORE_COMMANDS: ReadonlySet<string> = new Set(Object.values(SUPERVISED_ROLE_COMMANDS));
const STORE_CHOOSING_COMMANDS: readonly string[] = Object.values(INTERNAL_COMMANDS).filter((command) => !GIVEN_STORE_COMMANDS.has(command));

const storeChoosingSelfLaunch = (name: LauncherName, args: readonly unknown[]): string | undefined => {
  const words = name === 'exec' || name === 'execSync' ? String(args[0]).split(/\s+/) : [String(args[0]), ...argvOf(args)];
  return STORE_CHOOSING_COMMANDS.find((command) => words.includes(command));
};

export const secretStoreLaunchRefusal = (name: LauncherName, args: readonly unknown[]): string | undefined => {
  const options = optionsOf(args);
  const env = options.env ?? process.env;
  const command = String(args[0]);
  const program = realSecretProgram(commandOf(name, args, options), env, options.cwd);
  if (program !== undefined) return `refused to launch ${command}: (i) it is the real secret store program ${program}, outside the fake directory`;
  const given = givenSecretProgramOutsideFakes(env);
  if (given !== undefined) return `refused to launch ${command}: (ii) its environment gives MOMONGA_SECRET_PROGRAM=${given}, outside the fake directory`;
  const selfLaunch = storeChoosingSelfLaunch(name, args);
  if (selfLaunch !== undefined) {
    const chosen = chosenSecretProgramOutsideFakes(env);
    if (chosen !== undefined) return `refused to launch ${command}: (iii) it is the product self-launch ${selfLaunch}, which would choose the secret store ${chosen} from its PATH, outside the fake directory`;
  }
  return undefined;
};

const childProcess = createRequire(import.meta.url)('node:child_process') as Record<string, unknown>;

const checked = (name: LauncherName, launch: Launch): Launch =>
  function checkedLaunch(this: unknown, ...args: unknown[]): unknown {
    const refusal = secretStoreLaunchRefusal(name, args);
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
