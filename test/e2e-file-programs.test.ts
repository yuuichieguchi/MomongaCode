import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_SECRET_PROGRAMS_ENV, fakeBrowserOf } from '@momonga/testkit';
import { fileProgramsEnv } from '../e2e/support/file-programs-env.ts';

const RUN_BIN = path.join(path.sep, 'tmp', 'run-fakes', 'bin');
const FILE_BIN = path.join(path.sep, 'tmp', 'file-fakes', 'bin');

describe('the fake programs of one e2e file', () => {
  it('take the place of the run fakes in PATH, BROWSER and the fake programs variable, and keep every other PATH entry in order', () => {
    const env = { [TEST_SECRET_PROGRAMS_ENV]: RUN_BIN, PATH: [RUN_BIN, '/usr/bin', RUN_BIN, '/bin'].join(path.delimiter), BROWSER: fakeBrowserOf(RUN_BIN), HOME: '/h' };
    expect(fileProgramsEnv(env, FILE_BIN)).toEqual({
      [TEST_SECRET_PROGRAMS_ENV]: FILE_BIN,
      PATH: [FILE_BIN, '/usr/bin', '/bin'].join(path.delimiter),
      BROWSER: fakeBrowserOf(FILE_BIN),
    });
  });

  it('refuse an environment whose fake programs variable is not set', () => {
    expect(() => fileProgramsEnv({ PATH: '/usr/bin' }, FILE_BIN)).toThrow(TEST_SECRET_PROGRAMS_ENV);
  });
});
