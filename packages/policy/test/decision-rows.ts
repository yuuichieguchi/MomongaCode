import fs from 'node:fs';
import path from 'node:path';
import { EMPTY_PROTECTED_SET } from '@momonga/foundation';
import type { ProtectedSet } from '@momonga/foundation';
import { decide } from '@momonga/policy';
import type { Decision, PermissionSubject, PolicyFilesystem, PolicyTool, RuleEffect } from '@momonga/policy';
import type { PermissionMode } from '@momonga/protocol';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout, protectedSetOf, ruleIn, touch } from './helpers.ts';
import type { FakeFsLayout, Layout } from './helpers.ts';

export const MODES = ['manual', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
export const RULE_MODES = ['manual', 'acceptEdits', 'bypassPermissions'] as const;

export const BASH: PolicyTool = { name: 'Bash', kind: 'execute', sideEffect: 'exec', subjectKind: 'command' };
export const WRITE: PolicyTool = { name: 'Write', kind: 'edit', sideEffect: 'write', subjectKind: 'path' };

export type Cell = 'allow' | 'ask' | 'deny' | 'prot';

export type Row = {
  id: string;
  command?: string;
  write?: (layout: Layout) => string;
  rules?: ReadonlyArray<readonly [RuleEffect, string]>;
  after: readonly [Cell, Cell, Cell, Cell];
  pin: boolean;
  roots?: (layout: Layout) => string[];
  cwd?: (layout: Layout) => string;
  fs?: (layout: Layout) => FakeFsLayout;
  searchPath?: string | undefined;
  protection?: boolean;
  prepare?: (layout: Layout) => void;
};

export const P = (layout: Layout, ...parts: string[]): string => path.join(layout.project, ...parts);

const prepareWorkspace = (layout: Layout): void => {
  for (const name of ['README.md', 'f', 'a.txt', 'x.png', 'm', 'x', 'src/a.ts', 'src/b.py', 'build/o']) touch(P(layout, name));
};

export type RowContext = { layout: Layout; roots: string[]; cwd: string; filesystem: PolicyFilesystem; protectedSet: ProtectedSet };

export const contextOf = async (row: Row): Promise<RowContext> => {
  const layout = makeLayout();
  prepareWorkspace(layout);
  row.prepare?.(layout);
  const roots = row.roots?.(layout) ?? [layout.project];
  const cwd = row.cwd?.(layout) ?? layout.project;
  const filesystem = fakeFs(row.fs?.(layout) ?? {});
  const protectedSet = row.protection === true ? await protectedSetOf(roots, filesystem) : EMPTY_PROTECTED_SET;
  return { layout, roots, cwd, filesystem, protectedSet };
};

export const subjectOf = (row: Row, context: RowContext): { tool: PolicyTool; subject: PermissionSubject } =>
  row.write === undefined
    ? { tool: BASH, subject: { kind: 'command', tool: 'Bash', command: row.command as string } }
    : { tool: WRITE, subject: { kind: 'path', tool: 'Write', paths: [row.write(context.layout)], access: 'write' } };

export const decideRow = async (row: Row, mode: PermissionMode, given?: RowContext): Promise<Decision> => {
  const context = given ?? (await contextOf(row));
  const make = ruleIn(context.layout);
  const rules = (row.rules ?? []).map(([effect, text]) => make(effect, text));
  const { tool, subject } = subjectOf(row, context);
  return await decide({
    tool,
    subject,
    mode,
    rules,
    roots: context.roots,
    home: context.layout.home,
    cwd: context.cwd,
    fileRules: await fileRulesFor(rules, context.roots),
    fs: context.filesystem, searchPath: 'searchPath' in row ? row.searchPath : TEST_SEARCH_PATH, isWritable: isWritableFor(context.roots),
    protectedSet: context.protectedSet,
  });
};

export const cellOf = (decision: Decision): Cell => (decision.kind === 'ask' && decision.source === 'protected' ? 'prot' : decision.kind);

export const cellAt = (row: Row, mode: (typeof MODES)[number]): Cell => row.after[MODES.indexOf(mode)] as Cell;

export const commandRows = (rows: readonly Row[]): Row[] => rows.filter((row) => row.write === undefined);

const allow4: Row['after'] = ['allow', 'allow', 'allow', 'allow'];
const askExceptBypass: Row['after'] = ['ask', 'ask', 'ask', 'allow'];
const acceptOnly: Row['after'] = ['ask', 'allow', 'ask', 'allow'];
const deny4: Row['after'] = ['deny', 'deny', 'deny', 'deny'];
const prot4: Row['after'] = ['prot', 'prot', 'prot', 'prot'];
const protWrite: Row['after'] = ['prot', 'prot', 'deny', 'prot'];

const gitDirectory = (layout: Layout, ...parts: string[]): void => {
  touch(P(layout, ...parts, '.git', 'config'));
};

export const validGitDirectory = (layout: Layout, ...parts: string[]): void => {
  const gitPath = P(layout, ...parts, '.git');
  fs.mkdirSync(path.join(gitPath, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(gitPath, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(gitPath, 'HEAD'), 'ref: refs/heads/main\n');
};

const symlinkTo = (target: string, link: string): void => {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link);
};

const ssh = (layout: Layout): string => touch(path.join(layout.home, '.ssh', 'id_rsa'));

export const globAt = (layout: Layout, pattern: string, matches: string[], cwd = layout.project): FakeFsLayout => ({
  globs: { [path.resolve(cwd, pattern)]: { matches } },
});

export const DEFAULT_COMMAND_PATH_VALUE = '/usr/bin:/bin:/usr/sbin:/sbin';

const commandPathSed: FakeFsLayout = {
  programs: { sed: '/opt/homebrew/bin/sed' },
  programsBySearchPath: { [DEFAULT_COMMAND_PATH_VALUE]: { sed: '/usr/bin/sed' } },
};

export const ACCEPT_EDITS_ROWS: readonly Row[] = [
  { id: 'A1', command: 'mkdir out', after: acceptOnly, pin: false },
  { id: 'A2', command: 'touch a.txt', after: acceptOnly, pin: false },
  { id: 'A3', command: 'rm src/a.ts', after: acceptOnly, pin: false },
  { id: 'A4', command: 'rm -rf .git', after: prot4, pin: false, protection: true, prepare: (layout) => gitDirectory(layout) },
  { id: 'A5', command: 'rm -rf /tmp/x', after: askExceptBypass, pin: true },
  { id: 'A6', command: 'rm -rf .', after: askExceptBypass, pin: true },
  { id: 'A7', command: 'mv a b', after: acceptOnly, pin: false, prepare: (layout) => void touch(P(layout, 'a')) },
  { id: 'A8', command: 'cp a /tmp/x', after: askExceptBypass, pin: true, prepare: (layout) => void touch(P(layout, 'a')) },
  { id: 'A9', command: "sed -i '' s/a/b/ f", after: acceptOnly, pin: false },
  { id: 'A10', command: 'sed -n 1p f', after: allow4, pin: false },
  { id: 'A11', command: "sed -n 'w out' f", after: askExceptBypass, pin: true },
  { id: 'A12', command: 'rm --frobnicate x', after: askExceptBypass, pin: true },
  { id: 'A13', command: 'mytool x', after: askExceptBypass, pin: true },
  { id: 'A14', command: 'mkdir a && mytool b', after: askExceptBypass, pin: true },
  { id: 'A15', command: 'mkdir a && touch b', after: acceptOnly, pin: false },
  { id: 'A16', command: 'timeout 5 mkdir a', after: acceptOnly, pin: false },
  { id: 'A17', command: 'touch -t 200101010000 a', after: askExceptBypass, pin: true },
  { id: 'A18', command: 'touch *.txt', after: askExceptBypass, pin: true, fs: (layout) => globAt(layout, '*.txt', ['a.txt']) },
  { id: 'A19', command: 'rm $F', after: askExceptBypass, pin: true },
  { id: 'A20', command: 'mkdir a; touch .env', rules: [['deny', 'Write(.env)']], after: deny4, pin: true },
  { id: 'A21', command: 'rm .env', rules: [['deny', 'Write(.env)']], after: deny4, pin: false, prepare: (layout) => void touch(P(layout, '.env')) },
  { id: 'A22', command: "sed -i '' 'w .git/hooks/x' f", after: prot4, pin: false, protection: true, prepare: (layout) => gitDirectory(layout) },
  { id: 'A23', command: 'cp -S ~/x ./y', after: askExceptBypass, pin: true },
  { id: 'A24', command: 'LANG=C mkdir a', after: askExceptBypass, pin: true },
  { id: 'A25', command: 'mkdir a > out.txt', after: acceptOnly, pin: false },
  { id: 'A26', command: 'sed -n 1p f', after: askExceptBypass, pin: true, fs: () => ({ programs: { sed: '/opt/homebrew/bin/sed' } }) },
  { id: 'CP2', command: 'command -p sed -n 1p f', after: allow4, pin: false, fs: () => commandPathSed },
  { id: 'CP3', command: "command -p sed -i '' s/a/b/ f", after: acceptOnly, pin: false, fs: () => commandPathSed },
  { id: 'CP4', command: 'command -pv sed', after: askExceptBypass, pin: true },
];

export const READ_ONLY_ROWS: readonly Row[] = [
  { id: 'R1', command: 'ls src', after: allow4, pin: false },
  { id: 'R2', command: 'ls /etc', after: askExceptBypass, pin: true },
  { id: 'R3', command: 'cat README.md', after: allow4, pin: false },
  { id: 'R4', command: 'git status', after: allow4, pin: false },
  { id: 'R5', command: 'git -C ../x status', after: askExceptBypass, pin: true },
  { id: 'R6', command: 'git log --output=o', after: askExceptBypass, pin: true },
  { id: 'R7', command: 'find . -name x', after: allow4, pin: false },
  { id: 'R8', command: 'find . -delete', after: askExceptBypass, pin: true },
  { id: 'R9', command: 'find . -fprint o', after: askExceptBypass, pin: true },
  { id: 'R10', command: 'find . -exec ls {} ;', after: askExceptBypass, pin: true },
  { id: 'R11', command: 'ls *.ts', after: allow4, pin: false, fs: (layout) => globAt(layout, '*.ts', ['b.ts']), prepare: (layout) => void touch(P(layout, 'b.ts')) },
  { id: 'R12', command: 'sort *.txt', after: askExceptBypass, pin: true, fs: (layout) => globAt(layout, '*.txt', ['a.txt']) },
  { id: 'R13', command: 'sort a.txt', after: allow4, pin: false },
  { id: 'R14', command: 'sort -o out a.txt', after: askExceptBypass, pin: true },
  { id: 'R16', command: 'cd ../x && git log', after: askExceptBypass, pin: true },
  { id: 'R17', command: 'cd src && ls', after: allow4, pin: false },
  { id: 'R19', command: 'ps aux', after: allow4, pin: false, fs: () => ({ platform: 'linux' }) },
  { id: 'R20', command: 'ps auxe', after: askExceptBypass, pin: true, fs: () => ({ platform: 'linux' }) },
  { id: 'R21', command: 'ps aux -e', after: askExceptBypass, pin: true, fs: () => ({ platform: 'linux' }) },
  { id: 'R22', command: 'file x.png', after: allow4, pin: false },
  { id: 'R23', command: 'file -m m x', after: askExceptBypass, pin: true },
  { id: 'R24', command: 'echo hi', after: allow4, pin: false },
  { id: 'R26', command: 'cat $F', after: askExceptBypass, pin: true },
  { id: 'R27', command: 'PATH=/x ls', after: askExceptBypass, pin: true },
  { id: 'R28', command: 'ls | grep x', after: allow4, pin: false },
  { id: 'R29', command: 'ls | sh', after: askExceptBypass, pin: true },
  { id: 'R30', command: '(ls)', after: askExceptBypass, pin: true },
  { id: 'R32', command: 'cat .env', rules: [['deny', 'Read(.env)']], after: deny4, pin: true },
  { id: 'R42', command: 'ls --frobnicate', after: askExceptBypass, pin: true },
];

export const LITERAL_ROWS: readonly Row[] = [
  { id: 'L1', command: 'timeout 30 npm test', rules: [['allow', 'Bash(npm test:*)']], after: allow4, pin: false },
  { id: 'L2', command: 'nice -n 5 make build', rules: [['allow', 'Bash(make:*)']], after: allow4, pin: false },
  { id: 'L4', command: 'env FOO=1 npm test', rules: [['allow', 'Bash(npm test:*)']], after: askExceptBypass, pin: true },
  { id: 'L5', command: 'git -c core.pager=x log', rules: [['allow', 'Bash(git:*)']], after: allow4, pin: false },
  { id: 'L6', command: 'git --git-dir=/x log', rules: [['allow', 'Bash(git:*)']], after: allow4, pin: false },
  { id: 'L7', command: 'git -C /x log', rules: [['allow', 'Bash(git log:*)']], after: askExceptBypass, pin: true },
  { id: 'L8', command: 'find . -delete', rules: [['allow', 'Bash(find:*)']], after: askExceptBypass, pin: true },
  { id: 'L9', command: 'find build -delete', rules: [['allow', 'Bash(find:*)']], after: acceptOnly, pin: false },
  { id: 'L10', command: 'find . -fprint o', rules: [['allow', 'Bash(find:*)']], after: allow4, pin: false },
  { id: 'L11', command: 'npm exec foo', rules: [['allow', 'Bash(npm:*)']], after: allow4, pin: false },
  { id: 'L12', command: 'npx foo', rules: [['allow', 'Bash(npx:*)']], after: allow4, pin: false },
  { id: 'L13', command: 'npm run test --script-shell=/tmp/x', rules: [['allow', 'Bash(npm run test:*)']], after: allow4, pin: false },
  { id: 'L14', command: 'git log --output=o', rules: [['allow', 'Bash(git:*)']], after: acceptOnly, pin: false },
  { id: 'L15', command: 'rsync -e ./x a b', rules: [['allow', 'Bash(rsync:*)']], after: acceptOnly, pin: true },
  { id: 'L16', command: "sed -e 'w out' f", rules: [['allow', 'Bash(sed:*)']], after: acceptOnly, pin: false },
  { id: 'L17', command: 'rm --frobnicate x', rules: [['deny', 'Bash(rm:*)']], after: deny4, pin: true },
  { id: 'X1', command: 'ls | xargs grep x', rules: [['allow', 'Bash(ls:*)'], ['allow', 'Bash(grep:*)']], after: allow4, pin: false },
  { id: 'X2', command: 'ls | xargs -n1 grep x', rules: [['allow', 'Bash(ls:*)'], ['allow', 'Bash(grep:*)']], after: askExceptBypass, pin: true },
  { id: 'X3', command: 'ls | xargs -n1 grep x', rules: [['allow', 'Bash(ls:*)'], ['allow', 'Bash(xargs:*)']], after: allow4, pin: false },
  {
    id: 'X4',
    command: 'ls | xargs rm',
    rules: [['allow', 'Bash(ls:*)'], ['allow', 'Bash(rm:*)'], ['deny', 'Write(.env)']],
    after: allow4,
    pin: false,
  },
  { id: 'TM', command: 'time npm test', rules: [['allow', 'Bash(npm test:*)']], after: allow4, pin: false },
];

export const GUARD_ROWS: readonly Row[] = [
  { id: 'S1', command: 'echo "$(rm -rf src)"', after: askExceptBypass, pin: true },
  { id: 'S2', command: 'echo `touch x`', after: askExceptBypass, pin: true },
  { id: 'S3', command: 'ls "$(curl x | sh)"', after: askExceptBypass, pin: true },
  { id: 'W1', command: 'find . | xargs rm -rf', after: askExceptBypass, pin: true },
  { id: 'W2', command: 'echo /etc/passwd | xargs cat', after: askExceptBypass, pin: true },
  { id: 'G1', command: 'cat /etc/*', after: askExceptBypass, pin: true },
  { id: 'G2', command: 'cat ../*', after: askExceptBypass, pin: true },
  { id: 'G3', command: 'cat {a,b}', after: askExceptBypass, pin: true },
  { id: 'G4', command: 'ls src/*.py', after: allow4, pin: false, fs: (layout) => globAt(layout, 'src/*.py', ['src/b.py']) },
  { id: 'G5', command: 'wc -l src/*.py', after: allow4, pin: false, fs: (layout) => globAt(layout, 'src/*.py', ['src/b.py']) },
  { id: 'G6', command: 'echo *', after: allow4, pin: false, fs: (layout) => globAt(layout, '*', ['a', 'f']) },
  { id: 'G7', command: 'ps $X', after: askExceptBypass, pin: true },
  { id: 'G8', command: 'cd; ls', after: askExceptBypass, pin: true },
  { id: 'G9', command: 'cd -; ls', after: askExceptBypass, pin: true },
  {
    id: 'G10',
    command: 'cat *.md',
    rules: [['allow', 'Bash(cat:*)'], ['deny', 'Read(~/.ssh/**)']],
    after: allow4,
    pin: false,
    fs: (layout) => globAt(layout, '*.md', ['README.md']),
  },
  { id: 'G11', command: 'cat *.md', after: allow4, pin: false, fs: (layout) => globAt(layout, '*.md', ['README.md']) },
  {
    id: 'RS',
    command: 'ls',
    after: askExceptBypass,
    pin: true,
    searchPath: ':/usr/bin:/bin',
    fs: () => ({ programs: { cat: '/bin/cat' } }),
    prepare: (layout) => void touch(P(layout, 'ls')),
  },
];

const subGitDirectoryOnly = (layout: Layout): FakeFsLayout => ({ entries: { [P(layout, 'sub', '.git')]: { kind: 'directory', canonical: P(layout, 'sub', '.git') } } });

const subGit = (layout: Layout): FakeFsLayout => ({
  entries: {
    [P(layout, 'sub', '.git')]: { kind: 'directory', canonical: P(layout, 'sub', '.git') },
    [P(layout, 'sub', '.git', 'objects')]: { kind: 'directory', canonical: P(layout, 'sub', '.git', 'objects') },
    [P(layout, 'sub', '.git', 'refs')]: { kind: 'directory', canonical: P(layout, 'sub', '.git', 'refs') },
    [P(layout, 'sub', '.git', 'HEAD')]: { kind: 'file', text: 'ref: refs/heads/main\n' },
  },
});

export const GIT_AND_LINK_ROWS: readonly Row[] = [
  { id: 'GS1', command: 'git status', after: allow4, pin: false },
  { id: 'GS2', command: 'git status', after: askExceptBypass, pin: true, cwd: (layout) => P(layout, 'sub'), fs: subGit, prepare: (layout) => fs.mkdirSync(P(layout, 'sub')) },
  {
    id: 'GS5',
    command: 'git status',
    after: allow4,
    pin: true,
    cwd: (layout) => P(layout, 'sub'),
    fs: subGitDirectoryOnly,
    prepare: (layout) => fs.mkdirSync(P(layout, 'sub')),
  },
  { id: 'GS3', command: 'git status', after: allow4, pin: false, cwd: (layout) => P(layout, 'sub'), prepare: (layout) => fs.mkdirSync(P(layout, 'sub')) },
  {
    id: 'GS4',
    command: 'git status',
    after: askExceptBypass,
    pin: true,
    cwd: (layout) => P(layout, 'sub', 'deep'),
    fs: subGit,
    prepare: (layout) => fs.mkdirSync(P(layout, 'sub', 'deep'), { recursive: true }),
  },
  {
    id: 'CP1',
    command: 'cp -s ../../f ../../l',
    after: askExceptBypass,
    pin: true,
    cwd: (layout) => P(layout, 'a', 'b'),
    prepare: (layout) => fs.mkdirSync(P(layout, 'a', 'b'), { recursive: true }),
  },
  { id: 'GL1', command: 'cat *', after: allow4, pin: false, fs: (layout) => globAt(layout, '*', ['ok.txt']), prepare: (layout) => void touch(P(layout, 'ok.txt')) },
  {
    id: 'GL2',
    command: 'cat *',
    after: askExceptBypass,
    pin: true,
    fs: (layout) => globAt(layout, '*', ['link']),
    prepare: (layout) => symlinkTo(ssh(layout), P(layout, 'link')),
  },
  { id: 'GL3', command: 'cat *', after: askExceptBypass, pin: true, fs: (layout) => ({ globs: { [P(layout, '*')]: { overflow: true } } }) },
  {
    id: 'OP1',
    command: 'rm a/l',
    after: askExceptBypass,
    pin: true,
    prepare: (layout) => symlinkTo(touch(path.join(layout.outside, 's')), P(layout, 'a', 'l')),
  },
  { id: 'OP2', command: 'grep -S x a/l', after: allow4, pin: false, prepare: (layout) => symlinkTo(touch(P(layout, 'inside.txt')), P(layout, 'a', 'l')) },
  {
    id: 'FE1',
    command: 'git status',
    after: askExceptBypass,
    pin: true,
    cwd: (layout) => P(layout, 'sub'),
    fs: (layout) => ({ entries: { [P(layout, 'sub', '.git')]: { unresolvable: { kind: 'errno', code: 'EACCES' } } } }),
    prepare: (layout) => fs.mkdirSync(P(layout, 'sub')),
  },
  {
    id: 'FE2',
    command: 'cat *',
    after: askExceptBypass,
    pin: true,
    fs: (layout) => ({ globs: { [P(layout, '*')]: { unresolvable: { kind: 'errno', code: 'EACCES' } } } }),
  },
  { id: 'FE3', command: 'ls', after: allow4, pin: false, fs: () => ({ programs: { ls: '/usr/bin/ls' } }) },
  { id: 'FE3a', command: 'ls', after: askExceptBypass, pin: true, fs: () => ({ programs: {} }) },
  { id: 'RC1', command: 'grep -R x .', after: allow4, pin: false },
  { id: 'RC2', command: 'grep -S -R x .', after: askExceptBypass, pin: true },
  { id: 'RC3', command: 'ls -R', after: allow4, pin: false },
  { id: 'RC4', command: 'ls -RL', after: askExceptBypass, pin: true },
  ...(['diff -r a b', 'diff --recursive a b'] as const).map(
    (command): Row => ({
      id: `RC4b ${command}`,
      command,
      after: askExceptBypass,
      pin: true,
      prepare: (layout) => {
        symlinkTo(touch(path.join(layout.outside, 's')), P(layout, 'a', 'l'));
        touch(P(layout, 'b', 'l'));
      },
    }),
  ),
  {
    id: 'RC4c',
    command: 'diff -r --no-dereference a b',
    after: allow4,
    pin: false,
    prepare: (layout) => {
      touch(P(layout, 'a', 'x'));
      touch(P(layout, 'b', 'x'));
    },
  },
  { id: 'RC5 du -sh .', command: 'du -sh .', after: allow4, pin: false },
  { id: 'RC5 du -L .', command: 'du -L .', after: askExceptBypass, pin: true },
  { id: 'RC6 find . -name x', command: 'find . -name x', after: allow4, pin: false },
  { id: 'RC6 find -L . -name x', command: 'find -L . -name x', after: askExceptBypass, pin: true },
  { id: 'RC7 cp -R a b', command: 'cp -R a b', after: acceptOnly, pin: false },
  { id: 'RC7 cp -RL a b', command: 'cp -RL a b', after: askExceptBypass, pin: true },
];

const worktreeLayout = (layout: Layout): string => {
  const gitDir = path.join(layout.outside, 'main', '.git', 'worktrees', 'wt');
  fs.mkdirSync(path.join(layout.outside, 'main', '.git', 'hooks'), { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(P(layout, '.git'), `gitdir: ${gitDir}\n`);
  return gitDir;
};

export const PROTECTED_ROWS: readonly Row[] = [
  { id: 'PG1', write: (layout) => P(layout, '.git', 'commondir'), after: protWrite, pin: false, protection: true, prepare: (layout) => gitDirectory(layout) },
  { id: 'PG2', write: (layout) => P(layout, 'sub', '.git', 'config'), after: protWrite, pin: false, protection: true, prepare: (layout) => gitDirectory(layout, 'sub') },
  { id: 'PG3', write: (layout) => P(layout, 'sub', '.git', 'HEAD'), after: protWrite, pin: false, protection: true, prepare: (layout) => gitDirectory(layout, 'sub') },
  { id: 'PG4', write: (layout) => P(layout, '.git', 'objects', 'ab'), after: protWrite, pin: false, protection: true, prepare: (layout) => gitDirectory(layout) },
  { id: 'PG5', write: (layout) => P(layout, '.git', 'hooks', 'pre-commit'), after: protWrite, pin: true, protection: true, prepare: (layout) => gitDirectory(layout) },
  { id: 'PG6', command: 'touch sub/.git/x', after: prot4, pin: false, protection: true, prepare: (layout) => gitDirectory(layout, 'sub') },
  { id: 'PG7', command: 'rm -rf sub/.git', rules: [['allow', 'Bash(rm:*)']], after: prot4, pin: false, protection: true, prepare: (layout) => gitDirectory(layout, 'sub') },
  { id: 'GF1', write: (layout) => P(layout, '.git'), after: protWrite, pin: false, protection: true, prepare: (layout) => void worktreeLayout(layout) },
  {
    id: 'GF2',
    write: (layout) => path.join(layout.outside, 'main', '.git', 'hooks', 'pre-commit'),
    after: protWrite,
    pin: false,
    protection: true,
    prepare: (layout) => void worktreeLayout(layout),
  },
  {
    id: 'GF3',
    write: (layout) => P(layout, 'inner', 'config'),
    after: protWrite,
    pin: false,
    protection: true,
    prepare: (layout) => fs.writeFileSync(P(layout, '.git'), 'gitdir: inner\n'),
  },
  {
    id: 'GF4',
    write: (layout) => P(layout, '.git', 'modules', 'subm', 'hooks', 'pre-commit'),
    after: protWrite,
    pin: false,
    protection: true,
    prepare: (layout) => gitDirectory(layout),
  },
  {
    id: 'GF5',
    command: 'git status',
    after: askExceptBypass,
    pin: true,
    protection: true,
    prepare: (layout) => {
      fs.writeFileSync(P(layout, '.git'), 'gitdir: x/y\n');
    },
  },
  { id: 'SD1', command: '/opt/homebrew/bin/sed -i s/a/b/ .git/HEAD', after: prot4, pin: false, protection: true, prepare: (layout) => gitDirectory(layout) },
  { id: 'SD2', command: 'PATH=/x sed -i s/a/b/ .git/HEAD', after: prot4, pin: false, protection: true, prepare: (layout) => gitDirectory(layout) },
  { id: 'SD3', command: 'sed -n p f; ./sed -i s/a/b/ .git/HEAD', after: prot4, pin: false, protection: true, prepare: (layout) => gitDirectory(layout) },
  {
    id: 'GF7',
    command: 'rm x && mkdir -p x/y',
    after: prot4,
    pin: false,
    protection: true,
    prepare: (layout) => {
      fs.writeFileSync(P(layout, '.git'), 'gitdir: x/y\n');
    },
  },
];

export const READ_RULE_ROWS: readonly Row[] = [
  { id: 'RW1', command: 'tee .env', rules: [['allow', 'Bash(tee:*)'], ['deny', 'Read(.env)']], after: deny4, pin: false },
  { id: 'RW2', command: 'tee .env', rules: [['allow', 'Bash(tee:*)'], ['ask', 'Read(.env)']], after: askExceptBypass, pin: false },
  { id: 'RW3', command: 'cp a.txt .env', rules: [['allow', 'Bash(cp:*)'], ['deny', 'Read(.env)']], after: deny4, pin: false },
  { id: 'RW4', command: 'echo x > .env', rules: [['allow', 'Bash(echo:*)'], ['deny', 'Read(.env)']], after: deny4, pin: false },
  { id: 'RW5', command: 'echo x > .env', rules: [['allow', 'Bash(echo:*)'], ['ask', 'Read(.env)']], after: askExceptBypass, pin: false },
  { id: 'RW6', write: (layout) => P(layout, '.env'), rules: [['deny', 'Read(.env)']], after: deny4, pin: false },
  { id: 'RW7', write: (layout) => P(layout, '.env'), rules: [['ask', 'Read(.env)']], after: ['ask', 'ask', 'deny', 'allow'], pin: false },
  { id: 'RW8', command: 'git checkout .env', rules: [['allow', 'Bash(git:*)'], ['deny', 'Read(.env)']], after: deny4, pin: false },
  { id: 'RW9', command: 'git checkout .env', rules: [['allow', 'Bash(git:*)'], ['ask', 'Read(.env)']], after: allow4, pin: true },
  { id: 'RW10', command: 'tee .env', rules: [['allow', 'Bash(tee:*)'], ['allow', 'Read(.env)']], after: acceptOnly, pin: true },
];

export const EARLY_REFUSAL_ROWS: readonly Row[] = [
  { id: 'B24', command: 'git checkout .env', rules: [['allow', 'Bash(git:*)'], ['deny', 'Write(.env)']], after: deny4, pin: false },
  { id: 'B25', command: 'git rm .env', rules: [['allow', 'Bash(git:*)'], ['deny', 'Write(.env)']], after: deny4, pin: false },
  { id: 'B27', command: 'curl -D .env -s u', rules: [['allow', 'Bash(curl:*)'], ['deny', 'Write(.env)']], after: deny4, pin: false },
  { id: 'B31', command: 'tee .git/hooks/h', rules: [['allow', 'Bash(tee:*)']], after: prot4, pin: true, protection: true, prepare: (layout) => gitDirectory(layout) },
  {
    id: 'C10',
    command: 'rm secret/x',
    rules: [['allow', 'Bash(rm:*)'], ['deny', 'Write(secret)']],
    after: deny4,
    pin: false,
    prepare: (layout) => void touch(P(layout, 'secret', 'x')),
  },
  { id: 'P1', command: 'git reset --hard', rules: [['allow', 'Bash(git:*)']], after: askExceptBypass, pin: false },
  { id: 'P2', command: 'git clean -fdx', rules: [['allow', 'Bash(git:*)']], after: askExceptBypass, pin: false },
  { id: 'P3', command: 'git checkout .', rules: [['allow', 'Bash(git:*)']], after: askExceptBypass, pin: false },
  { id: 'K2', command: 'bun run x', rules: [['allow', 'Bash(bun:*)']], after: allow4, pin: true },
  { id: 'go build', command: 'go build -o .env', rules: [['allow', 'Bash(go:*)'], ['deny', 'Write(.env)']], after: allow4, pin: true },
];

const homeRoots = (layout: Layout): string[] => [layout.project, layout.home];

export const REDIRECT_ROWS: readonly Row[] = [
  { id: 'T1', command: 'echo x > ~/n.txt', rules: [['allow', 'Bash(echo:*)']], roots: homeRoots, after: askExceptBypass, pin: false },
  { id: 'T2', command: 'echo x > *.txt', rules: [['allow', 'Bash(echo:*)']], after: askExceptBypass, pin: true },
  { id: 'T3', command: 'cat < ~/n.txt', rules: [['allow', 'Bash(cat:*)']], roots: homeRoots, after: allow4, pin: true, prepare: (layout) => void touch(path.join(layout.home, 'n.txt')) },
  { id: 'C1', command: 'echo x > ~root/.bashrc', rules: [['allow', 'Bash(echo:*)'], ['deny', 'Write(~/.bashrc)']], after: askExceptBypass, pin: false },
  { id: 'C2', command: 'cat < ~other/f', rules: [['allow', 'Bash(cat:*)'], ['deny', 'Read(~/.ssh/**)']], after: askExceptBypass, pin: false },
  { id: 'C3', command: 'echo x > "$HOME/.bashrc"', rules: [['deny', 'Write(~/.bashrc)']], after: askExceptBypass, pin: false },
  { id: 'C4', command: 'echo x > ~root/.bashrc', rules: [['allow', 'Bash(echo:*)']], after: askExceptBypass, pin: true },
  { id: 'C5', command: 'tar -C dist -czf out.tgz .', rules: [['allow', 'Bash(tar:*)']], after: askExceptBypass, pin: false },
  { id: 'C8', command: 'tee vendor/src/a.ts', rules: [['allow', 'Bash(tee:*)'], ['allow', 'Write(src/**)']], after: acceptOnly, pin: true },
  {
    id: 'C9',
    command: 'tee ../extra/a.ts',
    rules: [['allow', 'Bash(tee:*)'], ['allow', 'Write(*.ts)']],
    roots: (layout) => [layout.project, path.join(layout.root, 'extra')],
    after: acceptOnly,
    pin: true,
    prepare: (layout) => fs.mkdirSync(path.join(layout.root, 'extra')),
  },
];

export const ALL_ROWS: readonly Row[] = [
  ...ACCEPT_EDITS_ROWS,
  ...READ_ONLY_ROWS,
  ...LITERAL_ROWS,
  ...GUARD_ROWS,
  ...GIT_AND_LINK_ROWS,
  ...PROTECTED_ROWS,
  ...READ_RULE_ROWS,
  ...EARLY_REFUSAL_ROWS,
  ...REDIRECT_ROWS,
];

export const rowById = (id: string): Row => {
  const found = ALL_ROWS.find((row) => row.id === id);
  if (found === undefined) throw new Error(`no decision row ${id}`);
  return found;
};

export const columnModes = (row: Row): ReadonlyArray<(typeof MODES)[number]> => (row.write === undefined ? RULE_MODES : MODES);

export const kindIn = async (row: Row, mode: PermissionMode): Promise<Cell> => cellOf(await decideRow(row, mode));

export const commandRow = (command: string, extra: Omit<Row, 'id' | 'command' | 'after' | 'pin'> = {}): Row => ({
  id: command,
  command,
  after: ['ask', 'ask', 'ask', 'allow'],
  pin: false,
  ...extra,
});
