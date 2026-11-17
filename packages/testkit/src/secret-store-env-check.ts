import fs from 'node:fs';
import path from 'node:path';
import { findProgramOnPathSync } from '@momonga/foundation/program-search';
import { nodeFileSystemSync } from '@momonga/foundation/node-file-system';
import { SECRET_PROGRAM_ENV, SECRET_STORE_SEARCHED_PROGRAMS } from '@momonga/foundation/secret-store';

export const TEST_SECRET_PROGRAMS_ENV = 'MOMONGA_TEST_SECRET_PROGRAMS';

type ProcessEnv = Readonly<Record<string, string | undefined>>;

export const fakeSecretProgramsBin = (env: ProcessEnv = process.env): string => {
  const bin = env[TEST_SECRET_PROGRAMS_ENV];
  if (bin === undefined || bin === '') throw new Error(`${TEST_SECRET_PROGRAMS_ENV} is not set; the test run's global setup installs the fake secret store programs`);
  return bin;
};

export const realFileOf = (file: string): string | undefined => {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP' || code === 'EACCES') return undefined;
    throw error;
  }
};

export const isInsideFakeSecretPrograms = (file: string): boolean => {
  const bin = fakeSecretProgramsBin();
  const relative = path.relative(realFileOf(bin) ?? bin, realFileOf(file) ?? file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

export const givenSecretProgramOutsideFakes = (env: ProcessEnv): string | undefined => {
  const given = env[SECRET_PROGRAM_ENV];
  return given !== undefined && !isInsideFakeSecretPrograms(given) ? given : undefined;
};

export const chosenSecretProgramOutsideFakes = (env: ProcessEnv): string | undefined => {
  const chosen = SECRET_STORE_SEARCHED_PROGRAMS.map((program) => findProgramOnPathSync(program, env, nodeFileSystemSync)).find((found) => found !== undefined);
  return chosen !== undefined && !isInsideFakeSecretPrograms(chosen) ? chosen : undefined;
};

export const assertFakeSecretStoreEnv = (env: ProcessEnv, command: string): void => {
  const program = givenSecretProgramOutsideFakes(env) ?? chosenSecretProgramOutsideFakes(env);
  if (program !== undefined) {
    throw new Error(`the environment given to ${command} resolves the secret store to ${program}, outside the fake directory ${fakeSecretProgramsBin()}; build it with productTestEnv`);
  }
};
