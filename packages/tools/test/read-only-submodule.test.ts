import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REAL_PROCESS_TEST_TIMEOUT_MS } from '@momonga/testkit';
import { makeRealWorkspace } from './real-workspace.ts';
import type { RealWorkspace } from './real-workspace.ts';

const withPlantedSubmodule = (workspace: RealWorkspace, nested = false): { fired(): boolean } => {
  const marker = path.join(workspace.outside, 'fired');
  const script = path.join(workspace.outside, 'fsmonitor');
  fs.writeFileSync(script, `#!/bin/sh\n: > ${marker}\n`, { mode: 0o755 });
  workspace.initRepository();
  workspace.initRepository('sm');
  const planted = nested ? path.join(workspace.project, 'sm', 'inner') : path.join(workspace.project, 'sm');
  if (nested) {
    workspace.initRepository('sm/inner');
    workspace.git(path.join(workspace.project, 'sm'), 'add', 'inner');
    workspace.git(path.join(workspace.project, 'sm'), 'commit', '-q', '-m', 'inner');
  }
  workspace.git(planted, 'config', 'core.fsmonitor', script);
  workspace.git(workspace.project, 'add', 'sm');
  fs.writeFileSync(path.join(workspace.project, 'sm', 'extra'), '');
  return { fired: () => fs.existsSync(marker) };
};

const SUBMODULE_PROGRAM_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['filter.x.clean', 'cat'],
  ['filter.x.smudge', 'cat'],
  ['diff.external', 'prog'],
  ['diff.d.textconv', 'prog'],
  ['diff.d.command', 'prog'],
  ['include.path', '../other'],
];

const plantedKey = (workspace: RealWorkspace, key: string, value: string, nested = false): void => {
  const directory = nested ? path.join(workspace.project, 'sm', 'inner') : path.join(workspace.project, 'sm');
  const result = workspace.git(directory, 'config', key, value);
  if (result.status !== 0) throw new Error(result.stderr);
};

describe('review 2: a submodule whose configuration names a program is judged, an ordinary one is approved', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  const ENTERING = ['git status', 'git diff', 'git status --porcelain=v2', 'git diff --submodule=diff', 'git log -p --submodule=diff -1', 'git show --submodule=diff'];
  const NOT_ENTERING = ['git status --ignore-submodules=all', 'git diff --ignore-submodules=dirty', 'git log -p -1', 'git rev-parse HEAD', 'git log --submodule=log -1'];

  it.each(ENTERING)('%s is approved with an ordinary submodule', (command) => {
    const workspace = makeRealWorkspace();
    withPlantedSubmodule(workspace);
    expect(workspace.decide(command)).toMatchObject({ kind: 'allow', basis: 'read_only' });
  });

  describe.each(SUBMODULE_PROGRAM_KEYS)('with %s in the submodule configuration', (key, value) => {
    it.each(ENTERING)('%s asks', (command) => {
      const workspace = makeRealWorkspace();
      withPlantedSubmodule(workspace);
      plantedKey(workspace, key, value);
      expect(workspace.decide(command).kind).toBe('ask');
    });

    it.each(NOT_ENTERING)('%s does not enter the submodule and is approved', (command) => {
      const workspace = makeRealWorkspace();
      withPlantedSubmodule(workspace);
      plantedKey(workspace, key, value);
      expect(workspace.decide(command)).toMatchObject({ kind: 'allow', basis: 'read_only' });
    });
  });

  it('cd sm && git status is approved for an ordinary submodule and asks for one with a filter', () => {
    const workspace = makeRealWorkspace();
    withPlantedSubmodule(workspace);
    expect(workspace.decide('cd sm && git status')).toMatchObject({ kind: 'allow', basis: 'read_only' });
    plantedKey(workspace, 'filter.x.clean', 'cat');
    expect(workspace.decide('cd sm && git status').kind).toBe('ask');
  });

  it('a nested submodule with a diff driver asks from the top', () => {
    const workspace = makeRealWorkspace();
    withPlantedSubmodule(workspace, true);
    plantedKey(workspace, 'diff.d.textconv', 'prog', true);
    expect(workspace.decide('git status').kind).toBe('ask');
  });

  it('a repository inside the workspace that is not a submodule still asks from its own directory', () => {
    const workspace = makeRealWorkspace();
    workspace.initRepository();
    workspace.initRepository('other');
    expect(workspace.decide('cd other && git status').kind).toBe('ask');
  });

  it('real git: the filter of the submodule runs in a plain environment, so the check is not idle', () => {
    const workspace = makeRealWorkspace();
    withPlantedSubmodule(workspace);
    const marker = path.join(workspace.outside, 'filter-ran');
    const script = path.join(workspace.outside, 'filter');
    fs.writeFileSync(script, `#!/bin/sh\n: > ${marker}\ncat\n`, { mode: 0o755 });
    plantedKey(workspace, 'filter.x.clean', script);
    fs.writeFileSync(path.join(workspace.project, 'sm', '.gitattributes'), '* filter=x\n');
    fs.writeFileSync(path.join(workspace.project, 'sm', 'tracked'), 'two\n');
    execFileSync('/usr/bin/git', ['status'], { cwd: workspace.project, env: workspace.env(), stdio: 'ignore' });
    expect(fs.existsSync(marker)).toBe(true);
  });
});

describe('the submodule rule: plain git status is approved again', { timeout: REAL_PROCESS_TEST_TIMEOUT_MS }, () => {
  it.each(['git status', 'git diff', 'git status --porcelain=v2', 'git diff --stat', 'git status --ignore-submodules=untracked'])('%s is allowed as read-only with a planted submodule fsmonitor', (command) => {
    const workspace = makeRealWorkspace();
    withPlantedSubmodule(workspace);
    expect(workspace.decide(command)).toMatchObject({ kind: 'allow', basis: 'read_only' });
  });

  it('a submodule nested in a submodule is allowed too', () => {
    const workspace = makeRealWorkspace();
    withPlantedSubmodule(workspace, true);
    expect(workspace.decide('git status')).toMatchObject({ kind: 'allow', basis: 'read_only' });
  });

  it('real git: the override reaches the submodule process, with the plain run as control', () => {
    const workspace = makeRealWorkspace();
    const plant = withPlantedSubmodule(workspace);
    const overriding = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'false' };
    execFileSync('/usr/bin/git', ['status'], { cwd: workspace.project, env: workspace.env(overriding), stdio: 'ignore' });
    expect(plant.fired()).toBe(false);
    execFileSync('/usr/bin/git', ['status'], { cwd: workspace.project, env: workspace.env(), stdio: 'ignore' });
    expect(plant.fired()).toBe(true);
  });
});
