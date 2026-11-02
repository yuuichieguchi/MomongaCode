import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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

describe('the submodule rule: plain git status is approved again', () => {
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
