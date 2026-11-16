import { describe, expect, it } from 'vitest';
import config from '../vitest.config.ts';
import { refusedSelection } from '../e2e/global-setup.ts';
import { RUN_CLASS_KEY } from '../scripts/support/run-class.ts';

type Project = { test?: { name?: string; provide?: Record<string, unknown> } };

const projectsOf = (): Project[] => (config as { test?: { projects?: Project[] } }).test?.projects ?? [];

describe('the vitest projects', () => {
  it('every project declares its run class, so a run that starts daemons is never light', () => {
    const projects = projectsOf();
    expect(projects.length).toBeGreaterThan(0);
    expect(projects.filter((project) => project.test?.provide?.[RUN_CLASS_KEY] === undefined).map((project) => project.test?.name)).toEqual([]);
    expect(projects.find((project) => project.test?.name === 'packaging')?.test?.provide?.[RUN_CLASS_KEY]).toBe('heavy');
  });

  it('the merge gate runs the unit, the e2e and the packaging projects in one run, and a run that names no project is refused', () => {
    expect(refusedSelection(['vitest', 'run', '--project', 'unit', '--project', 'e2e', '--project', 'packaging'])).toBeUndefined();
    expect(refusedSelection(['vitest', 'run', '--project=unit', '--project=e2e'])).toBeUndefined();
    expect(refusedSelection(['vitest', 'run', '--project', 'e2e', 'e2e/cli.test.ts'])).toBeUndefined();
    expect(refusedSelection(['vitest', 'run'])).toMatch(/names no project/);
  });
});
