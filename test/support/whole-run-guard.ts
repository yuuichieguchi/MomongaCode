import { WHOLE_RUN_ENV, fileFiltersOf, projectsOf } from './test-reuse.ts';

export { WHOLE_RUN_ENV } from './test-reuse.ts';

export const WHOLE_RUN_PROJECTS: readonly string[] = ['unit', 'e2e', 'packaging'];

type Request = {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly projects: readonly string[];
};

export const wholeRunRefusalOf = ({ argv, env, projects }: Request): string | undefined => {
  if (env[WHOLE_RUN_ENV] === '1' || fileFiltersOf(argv).length > 0) return undefined;
  const named = projectsOf(argv);
  const started = (named.length > 0 ? named : projects).filter((project) => WHOLE_RUN_PROJECTS.includes(project));
  if (started.length === 0) return undefined;
  return `run-lock: this vitest run starts the whole ${started.join(', ')} project with no test file named, and is refused before any test starts. Name the test files to run (vitest run --project ${started[0]} <file>); for a whole run set ${WHOLE_RUN_ENV}=1 (npm run test, test:reuse, test:e2e and test:packaging set it).`;
};
