import path from 'node:path';
import { SECRET_PROGRAM_ENV, secretStoreEnvFor } from '@momonga/foundation/secret-store';

export const TEST_SECRET_PROGRAMS_ENV = 'MOMONGA_TEST_SECRET_PROGRAMS';

type ProcessEnv = Readonly<Record<string, string | undefined>>;

export const fakeSecretProgramsBin = (env: ProcessEnv = process.env): string => {
  const bin = env[TEST_SECRET_PROGRAMS_ENV];
  if (bin === undefined || bin === '') throw new Error(`${TEST_SECRET_PROGRAMS_ENV} is not set; the test run's global setup installs the fake secret store programs`);
  return bin;
};

export const isInsideFakeSecretPrograms = (file: string): boolean => {
  const relative = path.relative(fakeSecretProgramsBin(), file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

export const givenSecretProgramOutsideFakes = (env: ProcessEnv): string | undefined => {
  const given = env[SECRET_PROGRAM_ENV];
  return given !== undefined && !isInsideFakeSecretPrograms(given) ? given : undefined;
};

export const chosenSecretProgramOutsideFakes = (env: ProcessEnv): string | undefined => {
  const chosen = secretStoreEnvFor(env)[SECRET_PROGRAM_ENV];
  return chosen !== undefined && !isInsideFakeSecretPrograms(chosen) ? chosen : undefined;
};

export const assertFakeSecretStoreEnv = (env: ProcessEnv, command: string): void => {
  const program = givenSecretProgramOutsideFakes(env) ?? chosenSecretProgramOutsideFakes(env);
  if (program !== undefined) {
    throw new Error(`the environment given to ${command} resolves the secret store to ${program}, outside the fake directory ${fakeSecretProgramsBin()}; build it with productTestEnv`);
  }
};
