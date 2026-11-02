import fs from 'node:fs';
import path from 'node:path';
import { makeRealWorkspace } from '../real-workspace.ts';
import type { RealWorkspace } from '../real-workspace.ts';

export const CANARY = 'CANARY';

const LAYOUTS = ['bare', 'u40', 'g40', 'big', 'xobj', 'both', 'cd1'] as const;

export type DifferentialWorkspace = RealWorkspace & {
  hookScript: (name: string) => string;
  firedMarkers: () => string[];
  plantedBin: string;
};

const fsmonitorConfig = (script: string): string => `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ..\n\tfsmonitor = ${script}\n`;

export const writeLayoutFiles = (workspace: RealWorkspace, directory: string, head: string, config: string, objectsAndRefs: 'directories' | 'executables' = 'directories'): void => {
  if (objectsAndRefs === 'directories') {
    workspace.mkdir(`${directory}/objects`);
    workspace.mkdir(`${directory}/refs`);
  } else {
    workspace.write(`${directory}/objects`, '#!/bin/sh\n', 0o755);
    workspace.write(`${directory}/refs`, '#!/bin/sh\n', 0o755);
  }
  workspace.write(`${directory}/HEAD`, head);
  workspace.write(`${directory}/config`, config);
  workspace.mkdir(`${directory}/sub`);
};

export const makeDifferentialWorkspace = (): DifferentialWorkspace => {
  const workspace = makeRealWorkspace();
  const hookScript = (name: string): string => path.join(workspace.base, `hook-${name}.sh`);
  for (const name of [...LAYOUTS, 'echo']) {
    fs.writeFileSync(hookScript(name), `#!/bin/sh\ntouch ${path.join(workspace.base, `fired-${name}`)}\nprintf '\\0'\n`, { mode: 0o755 });
  }
  workspace.initRepository();
  for (const [name, content] of [['a', 'A\n'], ['b', 'B\n'], ['ab', 'AB\n'], ['.hid', 'H\n'], ['sub/f.txt', 'F\n'], ['deep/x/y/z', 'Z\n']] as const) workspace.write(name, content);
  workspace.write('../outside/CANARY-secret', `${CANARY}-OUTSIDE\n`);
  workspace.write('../CANARY-top', `${CANARY}-TOP\n`);
  workspace.write('../CANARY-leak', `${CANARY}-LEAK\n`);
  workspace.link(path.join(workspace.outside, 'CANARY-secret'), 'lnk');
  workspace.link(path.join(workspace.outside, 'CANARY-secret'), '[a]b');

  writeLayoutFiles(workspace, 'bare', 'ref: refs/heads/main\n', fsmonitorConfig(hookScript('bare')));
  workspace.mkdir('bare/in');
  workspace.link('bare/in', 'pl');
  writeLayoutFiles(workspace, 'u40', `${'A'.repeat(40)}\n`, fsmonitorConfig(hookScript('u40')));
  writeLayoutFiles(workspace, 'g40', `${'a'.repeat(40)}garbage\n`, fsmonitorConfig(hookScript('g40')));
  writeLayoutFiles(workspace, 'big', `ref: refs/heads/main\n${'#'.repeat(70_000)}\n`, fsmonitorConfig(hookScript('big')));
  writeLayoutFiles(workspace, 'xobj', 'ref: refs/heads/main\n', fsmonitorConfig(hookScript('xobj')), 'executables');

  workspace.initRepository('both');
  fs.cpSync(path.join(workspace.project, 'both', '.git', 'HEAD'), path.join(workspace.project, 'both', 'HEAD'));
  workspace.mkdir('both/objects');
  workspace.mkdir('both/refs');
  workspace.write('both/config', fsmonitorConfig(hookScript('both')));

  workspace.initRepository('cd0');
  const evil = path.join(workspace.project, 'cd0evil');
  fs.cpSync(path.join(workspace.project, 'cd0', '.git'), evil, { recursive: true });
  fs.appendFileSync(path.join(evil, 'config'), `[diff "x"]\n\ttextconv = ${hookScript('cd1')}\n`);
  workspace.write('cd0evil/info/attributes', '* diff=x\n');
  workspace.write('cd1/HEAD', 'ref: refs/heads/main\n');
  workspace.write('cd1/commondir', '../cd0evil\n');

  const plantedBin = workspace.mkdir('bin');
  fs.copyFileSync(hookScript('echo'), path.join(plantedBin, 'echo'));
  fs.chmodSync(path.join(plantedBin, 'echo'), 0o755);

  return {
    ...workspace,
    hookScript,
    plantedBin,
    firedMarkers: () => fs.readdirSync(workspace.base).filter((entry) => entry.startsWith('fired-')),
  };
};
