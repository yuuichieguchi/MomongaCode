import { afterAll } from 'vitest';
import { createFakePrograms, removeFakePrograms } from '@momonga/testkit';
import { fileProgramsEnv } from './file-programs-env.ts';

const programs = createFakePrograms();
Object.assign(process.env, fileProgramsEnv(process.env, programs.bin));

afterAll(() => {
  removeFakePrograms(programs.root, programs.token);
});
