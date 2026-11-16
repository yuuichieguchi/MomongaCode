import path from 'node:path';
import { TEST_SECRET_PROGRAMS_ENV, fakeBrowserOf, fakeSecretProgramsBin } from '@momonga/testkit';

type Env = Readonly<Record<string, string | undefined>>;

export type FileProgramsEnv = { [TEST_SECRET_PROGRAMS_ENV]: string; PATH: string; BROWSER: string };

export const fileProgramsEnv = (env: Env, bin: string): FileProgramsEnv => {
  const runBin = fakeSecretProgramsBin(env);
  const others = (env['PATH'] ?? '').split(path.delimiter).filter((entry) => entry !== '' && entry !== runBin);
  return { [TEST_SECRET_PROGRAMS_ENV]: bin, PATH: [bin, ...others].join(path.delimiter), BROWSER: fakeBrowserOf(bin) };
};
