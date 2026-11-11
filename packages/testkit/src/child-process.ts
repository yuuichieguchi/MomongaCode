import * as nodeChildProcess from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { TEST_SECRET_PROGRAMS_ENV } from './secret-store-env-check.ts';

export type * from 'node:child_process';

type Launch = (...args: unknown[]) => unknown;
type ProcessEnv = Readonly<Record<string, string | undefined>>;
type EnvOptions = { env?: ProcessEnv };

const withFakeProgramsFirst = (bin: string, env: ProcessEnv): ProcessEnv => {
  const current = env['PATH'];
  if (current === undefined) return env;
  if (current.split(path.delimiter)[0] === bin) return env;
  return { ...env, PATH: current === '' ? bin : `${bin}${path.delimiter}${current}` };
};

const isOptions = (arg: unknown): arg is EnvOptions => typeof arg === 'object' && arg !== null && !Array.isArray(arg);

const withFakeProgramsInChildEnv = (args: readonly unknown[]): readonly unknown[] => {
  const bin = process.env[TEST_SECRET_PROGRAMS_ENV];
  if (bin === undefined || bin === '') return args;
  const optionsAt = args.findIndex((arg, index) => index > 0 && isOptions(arg));
  if (optionsAt !== -1) {
    const options = args[optionsAt] as EnvOptions;
    return args.with(optionsAt, { ...options, env: withFakeProgramsFirst(bin, options.env ?? process.env) });
  }
  const inherited: EnvOptions = { env: withFakeProgramsFirst(bin, process.env) };
  const freeAt = args.findIndex((arg, index) => index > 0 && (arg === undefined || arg === null || typeof arg === 'function'));
  if (freeAt === -1) return [...args, inherited];
  return typeof args[freeAt] === 'function' ? args.toSpliced(freeAt, 0, inherited) : args.with(freeAt, inherited);
};

const facadeOf = <T extends Launch>(launch: T, withPromisified = true): T => {
  const facade = function launchWithFakeSecretPrograms(this: unknown, ...args: unknown[]): unknown {
    return launch.apply(this, [...withFakeProgramsInChildEnv(args)]);
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
