import * as nodeChildProcess from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { TEST_SECRET_PROGRAMS_ENV } from './secret-store-env-check.ts';

export type * from 'node:child_process';

type Launch = (...args: unknown[]) => unknown;
type EnvOptions = { env?: Readonly<Record<string, string | undefined>> };

const withFakeProgramsFirst = (env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> => {
  const bin = process.env[TEST_SECRET_PROGRAMS_ENV];
  const current = env['PATH'];
  if (bin === undefined || bin === '' || current === undefined) return env;
  if (current.split(path.delimiter)[0] === bin) return env;
  return { ...env, PATH: current === '' ? bin : `${bin}${path.delimiter}${current}` };
};

const withFakeProgramsInOptions = (args: readonly unknown[]): unknown[] =>
  args.map((arg, index) => {
    if (index === 0 || typeof arg !== 'object' || arg === null || Array.isArray(arg)) return arg;
    const options = arg as EnvOptions;
    return options.env === undefined ? arg : { ...options, env: withFakeProgramsFirst(options.env) };
  });

const facadeOf = <T extends Launch>(launch: T, withPromisified = true): T => {
  const facade = function launchWithFakeSecretPrograms(this: unknown, ...args: unknown[]): unknown {
    return launch.apply(this, withFakeProgramsInOptions(args));
  } as T;
  const custom = (launch as T & { [promisify.custom]?: Launch })[promisify.custom];
  if (withPromisified && custom !== undefined) Object.defineProperty(facade, promisify.custom, { value: facadeOf(custom, false) });
  return facade;
};

export const spawn = facadeOf(nodeChildProcess.spawn as Launch) as typeof nodeChildProcess.spawn;
export const spawnSync = facadeOf(nodeChildProcess.spawnSync as Launch) as typeof nodeChildProcess.spawnSync;
export const exec = facadeOf(nodeChildProcess.exec as Launch) as typeof nodeChildProcess.exec;
export const execSync = facadeOf(nodeChildProcess.execSync as Launch) as typeof nodeChildProcess.execSync;
export const execFile = facadeOf(nodeChildProcess.execFile as Launch) as typeof nodeChildProcess.execFile;
export const execFileSync = facadeOf(nodeChildProcess.execFileSync as Launch) as typeof nodeChildProcess.execFileSync;
export const fork = facadeOf(nodeChildProcess.fork as Launch) as typeof nodeChildProcess.fork;

const childProcess = { ...nodeChildProcess, spawn, spawnSync, exec, execSync, execFile, execFileSync, fork };

export default childProcess;
