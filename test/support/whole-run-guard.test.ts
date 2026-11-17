import { describe, expect, it } from 'vitest';
import config from '../../vitest.config.ts';
import { WHOLE_RUN_ENV, WHOLE_RUN_PROJECTS, wholeRunRefusalOf } from './whole-run-guard.ts';
import { TEST_REUSE_ENV, globalsOf } from './test-reuse.ts';

const PROJECTS = ['unit', 'calibration', 'packaging', 'e2e'];

const refusalOf = (argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): string | undefined => wholeRunRefusalOf({ argv, env, projects: PROJECTS });

describe('the whole-run guard', () => {
  it('refuses a unit run that names no file', () => {
    expect(refusalOf(['node', 'vitest.mjs', 'run', '--project', 'unit'])).toContain('unit');
  });

  it('refuses an e2e or packaging run that names no file', () => {
    expect(refusalOf(['node', 'vitest.mjs', 'run', '--project', 'e2e'])).toContain('e2e');
    expect(refusalOf(['node', 'vitest.mjs', 'run', '--project=packaging'])).toContain('packaging');
  });

  it('refuses a run with no --project, which starts every project, when it names no file', () => {
    expect(refusalOf(['node', 'vitest.mjs', 'run'])).toContain('unit');
  });

  it('refuses a run that names only a test-name filter and no file', () => {
    expect(refusalOf(['node', 'vitest.mjs', 'run', '--project', 'unit', '-t', 'some name'])).toContain('unit');
  });

  it('lets a run that names a test file start', () => {
    expect(refusalOf(['node', 'vitest.mjs', 'run', '--project', 'unit', 'test/support/whole-run-guard.test.ts'])).toBeUndefined();
    expect(refusalOf(['node', 'vitest.mjs', 'run', '--project', 'e2e', 'e2e/cli.test.ts'])).toBeUndefined();
  });

  it('lets a whole run start when the environment says the whole run is meant', () => {
    expect(refusalOf(['node', 'vitest.mjs', 'run', '--project', 'unit'], { [WHOLE_RUN_ENV]: '1' })).toBeUndefined();
  });

  it('does not treat any value other than 1 as a whole run', () => {
    expect(refusalOf(['node', 'vitest.mjs', 'run', '--project', 'unit'], { [WHOLE_RUN_ENV]: '0' })).toContain('unit');
  });

  it('does not refuse a calibration-only run, which is not one of the three whole-run projects', () => {
    expect(refusalOf(['node', 'vitest.mjs', 'run', '--project', 'calibration'])).toBeUndefined();
  });

  it('names the cause and the way to ask for a whole run', () => {
    const message = refusalOf(['node', 'vitest.mjs', 'run', '--project', 'unit']) ?? '';
    expect(message).toContain('no test file');
    expect(message).toContain(WHOLE_RUN_ENV);
  });

  it('names only projects that the vitest configuration defines', () => {
    const defined = (config.test?.projects ?? []).map((project) => (typeof project === 'object' && project !== null && 'test' in project ? project.test?.name : undefined));
    for (const name of WHOLE_RUN_PROJECTS) expect(defined).toContain(name);
  });

  it('keeps the whole-run variable out of the test reuse key', () => {
    const digests = { digestOf: () => 'absent', treeDigest: () => '' };
    const globals = globalsOf({}, digests, { [WHOLE_RUN_ENV]: '1', [TEST_REUSE_ENV]: '1' });
    expect(globals.env).not.toHaveProperty(WHOLE_RUN_ENV);
  });
});
