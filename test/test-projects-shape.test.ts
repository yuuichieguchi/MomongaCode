import { describe, expect, it } from 'vitest';
import config from '../vitest.config.ts';
import { refusedSelection } from '../e2e/global-setup.ts';
import { RUN_CLASS_KEY } from '../scripts/support/run-class.ts';
import { hostE2eFileWorkers } from '../e2e/support/parallelism.ts';

type Project = { test?: { name?: string; provide?: Record<string, unknown>; maxWorkers?: number; fileParallelism?: boolean; sequence?: { groupOrder?: number }; setupFiles?: string[] } };

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

  it('runs the e2e files beside each other, as many as the machine carries, after the unit files and each with its own fake programs', () => {
    const e2e = projectsOf().find((project) => project.test?.name === 'e2e')?.test;
    expect(e2e?.fileParallelism).toBeUndefined();
    expect(e2e?.maxWorkers).toBe(hostE2eFileWorkers());
    expect(e2e?.sequence?.groupOrder).toBe(1);
    expect(e2e?.setupFiles).toContain('e2e/support/file-programs.ts');
  });
});
