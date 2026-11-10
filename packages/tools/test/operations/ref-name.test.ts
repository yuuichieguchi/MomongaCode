import { spawnSync } from '@momonga/testkit/child-process';
import { describe, expect, it } from 'vitest';
import { validateToolInput } from '../../src/validate.ts';
import { countingRunner, makeGitWorld, operationTool, subjectFor } from './support.ts';

const REF_PROPERTIES: ReadonlyArray<readonly [string, string]> = [
  ['GitPush', 'branch'],
  ['GitBranch', 'name'],
  ['PullRequestCreate', 'head'],
  ['PullRequestCreate', 'base'],
];

const CORPUS = [
  'main', 'Main', 'feature/x', 'release/1.0', '+main', 'a+b', 'x@y', 'feat/ü', 'a.b', 'a-b', 'a_b',
  'ma*', 'a:refs/heads/main', 'main^', 'main~1', 'a b', 'a\tb', 'a?b', 'a[b', 'a\\b', '-x', '--force', '../x', 'x..y', 'x@{1}', '@{-1}',
  '/x', 'x/', 'x//y', 'x.lock', 'x.lock/y', '.x', 'x/.y', 'x.', 'HEAD', '@', '', 'a\u007fb',
];

const gitAccepts = (name: string): boolean => {
  if (name.startsWith('-') || name === 'HEAD' || name === '@') return false;
  return spawnSync('git', ['check-ref-format', `refs/heads/${name}`], { encoding: 'utf8' }).status === 0;
};

const filled = (operation: string, property: string, value: string): Record<string, unknown> => {
  const base: Record<string, unknown> = operation === 'GitPush' ? { remote: 'origin' } : operation === 'PullRequestCreate' ? { head: 'h', base: 'b', title: 't', body: '', headSha: 'a'.repeat(40) } : {};
  return { ...base, [property]: value };
};

describe('one rule decides whether a string is a ref name (git check-ref-format semantics)', () => {
  describe.each(REF_PROPERTIES)('%s.%s', (operation, property) => {
    it.each(CORPUS)('agrees with git about %j', async (name) => {
      const verdict = await validateToolInput(operationTool(operation, { runArgv: countingRunner().run }), filled(operation, property, name));
      expect(verdict.ok, `${JSON.stringify(name)} accepted=${verdict.ok} git=${gitAccepts(name)}`).toBe(gitAccepts(name));
    });
  });
});

describe('protectedRefs compare ref names without case', () => {
  it.each([['Main', 'main'], ['MAIN', 'main'], ['Release/1.0', 'release/*']])('treats %s as protected by %s', async (branch, pattern) => {
    const world = makeGitWorld();
    const tool = operationTool('GitPush', { runArgv: countingRunner().run, settings: { protectedRefs: [pattern] } });
    const subject = await subjectFor(tool, { remote: 'origin', branch }, world);
    expect(subject).toMatchObject({ approval: 'always' });
  });
});
