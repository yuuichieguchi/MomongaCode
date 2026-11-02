import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BASE_ENTRY_FLAGS, nodeEntryIo, parseFlags } from '@momonga/foundation';
import type { SupervisorEntryDeps } from '@momonga/supervisor';
import { runSupervise } from '../../packages/cli/src/daemon/supervise.ts';
import { entryFileLauncher } from './launcher.ts';
import type { LauncherOverrides } from './launcher.ts';
import { E2E_DIR_PREFIX, E2E_RUN_ENV, E2E_RUN_PATTERN } from './run-env.ts';

export const E2E_DEPS_ENV = 'MOMONGA_E2E_DEPS';

export const E2E_DEPS_KEYS = [
  'runtime',
  'gateway',
  'startupTimeoutMs',
  'lockWaitMs',
  'orphanGraceMs',
  'orphanReapGraceMs',
  'heldRetryMs',
  'restart',
  'intervals',
  'watchSettings',
  'launcherOverrides',
] as const;

export type E2eDeps = Pick<
  SupervisorEntryDeps,
  'runtime' | 'gateway' | 'startupTimeoutMs' | 'lockWaitMs' | 'orphanGraceMs' | 'orphanReapGraceMs' | 'heldRetryMs' | 'restart' | 'intervals' | 'watchSettings'
> & { launcherOverrides?: LauncherOverrides };

export type SupervisorHomeGuardInput = { env: Readonly<Record<string, string | undefined>>; userHome: string };

const ROOT_SUFFIX_PATTERN = '[A-Za-z0-9]{6}';
const KNOWN_DEPS_KEYS: ReadonlySet<string> = new Set(E2E_DEPS_KEYS);

const realpathOf = (value: string): string | Error => {
  try {
    return fs.realpathSync(value);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
};

export const guardSupervisorHome = (argv: readonly string[], input: SupervisorHomeGuardInput): string | undefined => {
  const { env, userHome } = input;
  const run = env[E2E_RUN_ENV];
  if (run === undefined || !E2E_RUN_PATTERN.test(run)) return `${E2E_RUN_ENV} must be 4 lowercase hex characters, got ${JSON.stringify(run)}`;
  const home = env['HOME'];
  if (home === undefined) return 'HOME is not set';
  const resolvedHome = realpathOf(home);
  if (resolvedHome instanceof Error) return `HOME ${home} cannot be resolved: ${resolvedHome.message}`;
  const basenamePattern = new RegExp(`^${E2E_DIR_PREFIX}${run}-${ROOT_SUFFIX_PATTERN}$`);
  if (!basenamePattern.test(path.basename(resolvedHome))) return `HOME ${resolvedHome} must be a directory named ${E2E_DIR_PREFIX}${run}-<6>`;
  const tmpdir = env['TMPDIR'];
  if (tmpdir === undefined) return 'TMPDIR is not set';
  const resolvedTmpdir = realpathOf(tmpdir);
  if (resolvedTmpdir instanceof Error) return `TMPDIR ${tmpdir} cannot be resolved: ${resolvedTmpdir.message}`;
  if (resolvedTmpdir !== resolvedHome) return `TMPDIR ${resolvedTmpdir} must equal HOME ${resolvedHome}`;
  if (resolvedHome === userHome) return `HOME ${resolvedHome} is the user home`;
  const argvHome = parseFlags(argv, BASE_ENTRY_FLAGS).home;
  if (argvHome === undefined) return '--home is required and must resolve to HOME';
  const resolvedArgvHome = realpathOf(argvHome);
  if (resolvedArgvHome instanceof Error) return `--home ${argvHome} cannot be resolved: ${resolvedArgvHome.message}`;
  if (resolvedArgvHome !== resolvedHome) return `--home ${resolvedArgvHome} must equal HOME ${resolvedHome}`;
  return undefined;
};

export const parseE2eDeps = (text: string): E2eDeps => {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('e2e deps must be a JSON object');
  for (const key of Object.keys(parsed)) {
    if (!KNOWN_DEPS_KEYS.has(key)) throw new Error(`unknown e2e deps key ${key}`);
  }
  return parsed as E2eDeps;
};

const withoutHarnessVariables = (source: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(source).filter(([name]) => name !== E2E_RUN_ENV && name !== E2E_DEPS_ENV));

const watchParentDeath = (): void => {
  let terminated = false;
  const terminate = (): void => {
    if (terminated) return;
    terminated = true;
    process.kill(process.pid, 'SIGTERM');
  };
  process.stdin.on('end', terminate);
  process.stdin.on('close', terminate);
  process.stdin.resume();
};

const refuse = (message: string): void => {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
};

export const supervisorMain = async (): Promise<void> => {
  const violation = guardSupervisorHome(process.argv.slice(2), { env: process.env, userHome: os.userInfo().homedir });
  if (violation !== undefined) {
    refuse(violation);
    return;
  }
  const depsFile = process.env[E2E_DEPS_ENV];
  if (depsFile === undefined) {
    refuse(`${E2E_DEPS_ENV} is not set`);
    return;
  }
  let loaded: E2eDeps;
  try {
    loaded = parseE2eDeps(fs.readFileSync(depsFile, 'utf8'));
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
    return;
  }
  const { launcherOverrides, ...rest } = loaded;
  const finished = runSupervise({ ...nodeEntryIo(), env: withoutHarnessVariables(process.env) }, { launcher: entryFileLauncher(launcherOverrides), deps: rest });
  watchParentDeath();
  await finished;
};

if (import.meta.main) await supervisorMain();
