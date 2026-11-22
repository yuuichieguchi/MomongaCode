import { afterAll, beforeAll } from 'vitest';
import { createFakePrograms, removeFakePrograms } from '@momonga/testkit';
import { fileProgramsEnv } from './file-programs-env.ts';

let programs: ReturnType<typeof createFakePrograms> | undefined;

beforeAll(() => {
  programs = createFakePrograms();
  Object.assign(process.env, fileProgramsEnv(process.env, programs.bin));
});

afterAll(() => {
  if (programs === undefined) return;
  removeFakePrograms(programs.root, programs.token);
  programs = undefined;
});
