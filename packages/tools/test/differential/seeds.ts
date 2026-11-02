import path from 'node:path';
import type { DifferentialWorkspace } from './fixture.ts';
import type { Case } from './oracles.ts';

const CAT = [['allow', 'Bash(cat:*)']] as const;

export type SeedPaths = Pick<DifferentialWorkspace, 'project' | 'plantedBin' | 'hookScript'>;

export const PLACEHOLDER_PATHS: SeedPaths = { project: '/', plantedBin: '/', hookScript: () => '/' };

const configLines = (directory: string, hook: string): string =>
  [`echo '[core]' > ${directory}/config`, `echo 'repositoryformatversion = 0' >> ${directory}/config`, `echo 'bare = false' >> ${directory}/config`, `echo 'worktree = ..' >> ${directory}/config`, `echo 'fsmonitor = ${hook}' >> ${directory}/config`].join(' && ');

export const readSeeds = (workspace: SeedPaths): Case[] => {
  const at = (relative: string): string => path.join(workspace.project, relative);
  return [
    { command: 'echo "`echo \\"\'\\"; touch pwn1; echo \\"\'\\"`"' },
    { command: 'echo "`echo \\"\'\\"; touch pwn2; echo \\"\'\\"`"', rules: CAT },
    { command: 'cat .*/CANARY-leak' },
    { command: 'cat .*/CANARY-leak', rules: CAT },
    { command: 'cat .?/.?/.?/CANARY-top', cwd: at('deep/x') },
    { command: 'ls .*' },
    { command: 'ls .*', cwd: at('deep/x') },
    { command: 'cat l[[:alpha:]]k' },
    { command: 'cat l[[:alpha:]]k', rules: CAT },
    { command: 'cat "[a]"*' },
    { command: 'cat "[a]"*', rules: CAT },
    { command: 'cat l[x"-"z]k' },
    { command: 'cat l[x"-"z]k', rules: CAT },
    { command: "cat l[x'-'z]k" },
    { command: 'cat l[x\\-z]k' },
    { command: 'git status', cwd: at('gf/sub') },
    { command: 'cd gf/sub && git status' },
    { command: 'cat [z-a]*' },
    { command: 'cat [z-a]*', rules: CAT },
    { command: 'git status', cwd: at('u40/sub') },
    { command: 'git status', cwd: at('g40/sub') },
    { command: 'git status', cwd: at('big/sub') },
    { command: 'git status', cwd: at('xobj/sub') },
    { command: 'cd u40/sub && git status' },
    { command: 'cd -P pl/.. && git status' },
    { command: 'cd -P pl/.. && echo "$(git status)"' },
    { command: 'cd pl/.. && git status' },
    { command: 'git reflog write HEAD $(git rev-parse HEAD) $(git rev-parse HEAD) evil' },
    { command: 'git reflog write refs/heads/main $(git rev-parse HEAD) $(git rev-parse HEAD) evil' },
    { command: 'git reflog write' },
    { command: 'git reflog HEAD' },
    { command: 'git reflog -n 1' },
    { command: 'git reflog show --output=pwn --format=x' },
    { command: 'git reflog --output=pwn' },
    { command: 'git reflog -p --ext-diff' },
    { command: 'git --bare status', cwd: at('both') },
    { command: 'git --bare log -1', cwd: at('both') },
    { command: 'cd bare && git status' },
    { command: 'cd bare && echo "$(git status)"' },
    { command: 'cd bare; echo `git status`' },
    { command: 'echo $(cd bare && git status)' },
    { command: 'cd ./bare && echo "$(echo "$(git status)")"' },
    { command: 'git status', cwd: at('bare') },
    { command: 'git log -p', cwd: at('cd1') },
    { command: 'cd cd1 && git log -p' },
    { command: "echo $(ls # ) '\n touch pwn3\n) # '" },
    { command: "echo \"$(ls # ) '\n touch pwn4\n) # '\"" },
    { command: 'cat {/etc/passwd,x}', rules: CAT },
    { command: 'cat /etc/{passwd,hosts}', rules: CAT },
    { command: 'cat /etc/pass*', rules: CAT },
    { command: 'cat {,/etc/}passwd', rules: CAT },
    { command: 'cat l*', rules: CAT },
    { command: 'cat l*' },
    { command: 'nice echo hi', searchPath: `${workspace.plantedBin}:/usr/bin:/bin` },
    { command: 'timeout 5 echo hi', searchPath: `${workspace.plantedBin}:/usr/bin:/bin` },
    { command: 'nohup echo hi', searchPath: `${workspace.plantedBin}:/usr/bin:/bin` },
    { command: 'echo $HOME' },
    { command: 'cat $HOME/x' },
    { command: 'git remote show /etc' },
    { command: 'git tag -a -l' },
    { command: 'git branch -l new' },
    { command: 'git tag -v -l v1' },
  ];
};

export const editSeeds = (workspace: SeedPaths): Case[] => {
  const hook = (name: string): string => workspace.hookScript(name);
  const create = (directory: string): string => `mkdir -p ${directory}/objects ${directory}/refs && echo 'ref: refs/heads/main' > ${directory}/HEAD && ${configLines(directory, hook('bare'))}`;
  return [
    { command: `${create('fresh1')} && cd fresh1 && git status`, mode: 'acceptEdits' },
    { command: `${create('fresh2')}; cd fresh2; git status`, mode: 'acceptEdits' },
    { command: `${create('fresh3')} && git --bare -C fresh3 status`, mode: 'acceptEdits' },
    { command: `${create('fresh4')} && cd fresh4 && git --bare status`, mode: 'acceptEdits' },
    { command: `${create('fresh5')} && cd -P fresh5 && git status`, mode: 'acceptEdits' },
    { command: `${create('.')} && git --bare status`, mode: 'acceptEdits' },
    { command: `mkdir -p fresh6/sub && ${create('fresh6')} && cd fresh6/sub && git status`, mode: 'acceptEdits' },
  ];
};
