import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './bundle.ts';
import { SEA_NODE_VERSION } from './node-runtime.ts';
import { TEST_REUSE_ENV } from '../test/support/reuse-observed.ts';
import { currentTestReusePlan } from '../test/support/test-reuse.ts';
import config from '../vitest.config.ts';

const workflow = fs.readFileSync(`${repoRoot}.github/workflows/ci.yml`, 'utf8');
const vitestConfig = fs.readFileSync(`${repoRoot}vitest.config.ts`, 'utf8');
const packageJson = JSON.parse(fs.readFileSync(`${repoRoot}package.json`, 'utf8')) as { scripts: Record<string, string> };

describe('CI configuration', () => {
  it('runs on the Node version the single executable ships', () => {
    expect(fs.readFileSync(`${repoRoot}.node-version`, 'utf8').trim()).toBe(SEA_NODE_VERSION);
    expect(workflow).toContain('node-version-file: .node-version');
    expect(workflow).not.toMatch(/^\s*node-version:/m);
  });

  it('runs typecheck and every test project', () => {
    for (const script of ['typecheck', 'test', 'test:e2e', 'test:packaging']) {
      expect(workflow).toContain(`run: npm ${script === 'test' ? '' : 'run '}${script}`);
    }
    expect(packageJson.scripts['test:packaging']).toBe('MOMONGA_WHOLE_RUN=1 vitest run --project packaging');
  });

  it('provides Java and the pinned TLC jar before the unit tests, from the one script that pins it', () => {
    const java = workflow.indexOf('actions/setup-java@');
    const fetch = workflow.indexOf('run: scripts/tlc.sh --fetch-jar');
    const unit = workflow.indexOf('run: npm test');
    expect(java).toBeGreaterThan(-1);
    expect(fetch).toBeGreaterThan(java);
    expect(unit).toBeGreaterThan(fetch);
    expect(workflow).not.toMatch(/[0-9a-f]{64}/);
    expect(workflow).not.toContain('tla2tools');
    expect(workflow).not.toMatch(/releases\/download/);
  });

  it('runs the formal tier on macOS and Linux only, and says so in the name of the Windows step', () => {
    expect(workflow).toMatch(/- name: Unit tests, without the TLC tier \(it needs bash, ps and \/usr\/bin\)\n {8}if: runner\.os == 'Windows'\n {8}run: npx vitest run --project unit --exclude test\/formal\/tlc\.test\.ts\n/);
    expect(workflow).toMatch(/- name: Unit tests\n {8}if: runner\.os != 'Windows'\n {8}run: npm test\n/);
    expect(workflow).toMatch(/- name: Fetch the pinned TLC jar\n {8}if: runner\.os != 'Windows'\n/);
    expect(workflow).toMatch(/uses: actions\/setup-java@[0-9a-f]{40}\n {8}if: runner\.os != 'Windows'\n/);
  });

  it('installs the compliance fixtures that the e2e project needs', () => {
    expect(workflow).toContain('npm ci --prefix compliance/open-responses');
  });

  it('declares read-only token permissions at the top level', () => {
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
  });

  it('pins every action to a full commit SHA', () => {
    const uses = [...workflow.matchAll(/^\s*- uses: (\S+)/gm)].map((match) => match[1] as string);
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) expect(reference).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  const ASSIGNMENT = /^([A-Z_][A-Z0-9_]*)=(\S*)$/;

  const scriptParts = (name: string): { assignments: Record<string, string>; command: string } => {
    const words = (packageJson.scripts[name] as string).split(' ');
    const commandStart = words.findIndex((word) => !ASSIGNMENT.test(word));
    const assignments = Object.fromEntries(words.slice(0, commandStart).map((word) => (ASSIGNMENT.exec(word) as RegExpExecArray).slice(1, 3) as [string, string]));
    return { assignments, command: words.slice(commandStart).join(' ') };
  };

  it('pins the reuse of model-checking results in each script that runs the tier: off in test and test:tlc-deep, on in test:reuse', () => {
    expect(scriptParts('test')).toEqual({ assignments: { [TEST_REUSE_ENV]: '0', MOMONGA_TLC_REUSE: '0', MOMONGA_WHOLE_RUN: '1' }, command: 'vitest run --project unit --project e2e --project packaging' });
    expect(scriptParts('test:reuse')).toEqual({ assignments: { [TEST_REUSE_ENV]: '1', MOMONGA_TLC_REUSE: '1', MOMONGA_WHOLE_RUN: '1' }, command: 'vitest run --project unit --project e2e --project packaging' });
    expect(scriptParts('test:tlc-deep')).toEqual({ assignments: { MOMONGA_TLC_TIER: 'deep', MOMONGA_TLC_REUSE: '1' }, command: 'vitest run --project unit test/formal' });
  });

  it('names the reuse variable in no other script, and never in the gate, CI or the container', () => {
    const naming = Object.entries(packageJson.scripts)
      .filter(([, text]) => text.includes('MOMONGA_TLC_REUSE'))
      .map(([name]) => name)
      .sort();
    expect(naming).toEqual(['test', 'test:reuse', 'test:tlc-deep']);
    for (const text of [workflow, fs.readFileSync(`${repoRoot}scripts/release.sh`, 'utf8'), fs.readFileSync(`${repoRoot}scripts/test-linux.sh`, 'utf8')]) {
      expect(text).not.toContain('MOMONGA_TLC_REUSE');
      expect(text).not.toContain('test:reuse');
    }
  });

  it('a project with no matching test file fails the run instead of passing green, unless the run replays test files', () => {
    const replaysAny = [...currentTestReusePlan().replayed.values()].some((files) => files.length > 0);
    expect((config as { test?: { passWithNoTests?: boolean } }).test?.passWithNoTests).toBe(replaysAny);
  });
});
