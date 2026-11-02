import path from 'node:path';
import type { Case } from './oracles.ts';
import type { DifferentialWorkspace } from './fixture.ts';

export type Rng = () => number;

export const seededRng = (seed: number): Rng => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;

const READ_NAMES = ['a', 'b', 'ab', 'lnk', '[a]b', 'sub', 'sub/f.txt', 'pl', 'bare', '.hid', 'tracked', 'deep', '../CANARY-leak', '../CANARY-top', '../outside', '../outside/CANARY-secret', 'CANARY-top', 'lnk', 'l'];

const SPECIAL = /[^A-Za-z0-9_./-]/;

const quoteText = (rng: Rng, text: string): string => {
  if (text === '') return '';
  const style = pick(rng, ['backslash', 'single', 'double', 'plain']);
  if (style === 'single') return `'${text}'`;
  if (style === 'double') return `"${text}"`;
  if (style === 'backslash' || SPECIAL.test(text)) return [...text].map((char) => (SPECIAL.test(char) ? `\\${char}` : char)).join('');
  return text;
};

const CLASSES = (char: string): string[] => [`[${char === '[' || char === ']' ? 'a' : char}]`, '[[:alpha:]]', '[!x]', '[a-z]', '[z-a]', '[^a]', '[[:digit:]]', '[[:alpha:][:digit:]]', '[]]'];

const globComponent = (rng: Rng, component: string): string => {
  if (component === '..') return pick(rng, ['..', '.?', '.[.]', '.*', quoteText(rng, '..')]);
  if (component === '.') return '.';
  const operation = pick(rng, ['literal', 'prefix-star', 'question', 'class', 'dot-star', 'quoted-star', 'suffix-star']);
  const chars = [...component];
  const at = Math.floor(rng() * chars.length);
  switch (operation) {
    case 'prefix-star':
      return `${quoteText(rng, chars.slice(0, at + 1).join(''))}*`;
    case 'suffix-star':
      return `*${quoteText(rng, chars.slice(at).join(''))}`;
    case 'question':
      return `${quoteText(rng, chars.slice(0, at).join(''))}?${quoteText(rng, chars.slice(at + 1).join(''))}`;
    case 'class':
      return `${quoteText(rng, chars.slice(0, at).join(''))}${pick(rng, CLASSES(chars[at] as string))}${quoteText(rng, chars.slice(at + 1).join(''))}`;
    case 'dot-star':
      return component.startsWith('.') ? '.*' : `.*${quoteText(rng, component)}`;
    case 'quoted-star':
      return `${quoteText(rng, component.slice(0, 3))}*`;
    default:
      return quoteText(rng, component);
  }
};

const wordOf = (rng: Rng): string => {
  const name = pick(rng, READ_NAMES);
  const components = name.split('/').map((component) => globComponent(rng, component));
  if (rng() < 0.15) components.unshift(pick(rng, ['.*', '.?', '.[.]']));
  return components.join('/');
};

const READERS = ['cat', 'ls', 'head -n 1', 'wc -l', 'grep -c x', 'ls -l', 'ls -d'];

const readerCommand = (rng: Rng): string => `${pick(rng, READERS)} ${Array.from({ length: 1 + Math.floor(rng() * 2) }, () => wordOf(rng)).join(' ')}`;

const escapeForBackticks = (inner: string, doubleQuoted: boolean): string => {
  const specials = doubleQuoted ? /[\\`$"]/g : /[\\`$]/g;
  return inner.replace(specials, (char) => `\\${char}`);
};

const PAYLOADS = (index: number): string[] => [
  `echo "'"; touch pwn${index}; echo "'"`,
  `echo '"'; touch pwn${index}; echo '"'`,
  `echo "\\""; touch pwn${index}`,
  `echo '\\'; touch pwn${index}; echo '`,
  `echo "$(touch pwn${index})"`,
  `touch pwn${index}`,
];

const nested = (rng: Rng, inner: string): string =>
  pick(rng, [
    () => `echo "$(${inner})"`,
    () => `echo $(${inner})`,
    () => `echo \`${escapeForBackticks(inner, false)}\``,
    () => `echo "\`${escapeForBackticks(inner, true)}\`"`,
    () => `echo "$(echo "\`${escapeForBackticks(inner, true)}\`")"`,
    () => `x=\`${escapeForBackticks(inner, false)}\``,
  ])();

const GIT_FORMS = ['git status', 'git status -s', 'git log -1 --oneline', 'git diff', 'git rev-parse HEAD', 'git reflog', 'git reflog show', 'git reflog list', 'git reflog exists HEAD', 'git reflog write HEAD $(git rev-parse HEAD) $(git rev-parse HEAD) evil', 'git reflog -n 1', 'git --bare status', 'git branch', 'git show -s', 'git log -p -1'];
const DIRECTORIES = ['sub', 'pl', 'bare', 'u40/sub', 'g40/sub', 'big/sub', 'xobj/sub', 'both', 'cd1', 'deep/x', 'pl/..', 'bare/in', 'bare/in/..', 'sub/..'];
const CD_FORMS = (directory: string): string[] => [`cd ${directory}`, `cd -P ${directory}`, `cd -L ${directory}`, `cd -- ${directory}`, `cd ./${directory}`, `cd -P -- ${directory}`, `cd "${directory}"`];
const START_DIRECTORIES = ['', 'sub', 'u40/sub', 'g40/sub', 'big/sub', 'xobj/sub', 'both', 'cd1', 'bare', 'deep/x'];

const gitCommand = (rng: Rng): { command: string; cwd: string } => {
  const start = pick(rng, START_DIRECTORIES);
  const steps = Array.from({ length: Math.floor(rng() * 3) }, () => pick(rng, CD_FORMS(pick(rng, DIRECTORIES))));
  const joiner = pick(rng, [' && ', '; ']);
  return { command: [...steps, pick(rng, GIT_FORMS)].join(joiner), cwd: start };
};

const mutationScript = (rng: Rng, directory: string, hook: string): string => {
  const make = pick(rng, [`mkdir -p ${directory}/objects ${directory}/refs`, `mkdir ${directory} && mkdir ${directory}/objects ${directory}/refs`, `mkdir -p ${directory}/objects; mkdir -p ${directory}/refs`]);
  const head = pick(rng, [`echo 'ref: refs/heads/main' > ${directory}/HEAD`, `echo 'ref: refs/heads/main' >${directory}/HEAD`]);
  const config = [`echo '[core]' > ${directory}/config`, `echo 'repositoryformatversion = 0' >> ${directory}/config`, `echo 'bare = false' >> ${directory}/config`, `echo 'worktree = ..' >> ${directory}/config`, `echo 'fsmonitor = ${hook}' >> ${directory}/config`];
  const enter = pick(rng, [`cd ${directory}`, `cd ./${directory}`, `cd -P ${directory}`, '']);
  const git = enter === '' ? `git --bare -C ${directory} status` : pick(rng, ['git status', 'git --bare status']);
  const steps = [make, head, ...config, ...(enter === '' ? [] : [enter]), git];
  return steps.join(pick(rng, [' && ', '; ']));
};

export const generate = (rng: Rng, workspace: DifferentialWorkspace, count: number): Case[] => {
  const cases: Case[] = [];
  for (let index = 0; index < count; index += 1) {
    const family = pick(rng, ['reader', 'reader', 'nested-reader', 'git', 'git', 'nested-git', 'hidden', 'mutation']);
    const rules = rng() < 0.2 ? ([['allow', 'Bash(cat:*)']] as const) : undefined;
    const cwd = (relative: string): string => path.join(workspace.project, relative);
    switch (family) {
      case 'reader':
        cases.push({ command: readerCommand(rng), cwd: cwd(pick(rng, ['', 'deep/x', 'sub'])), ...(rules === undefined ? {} : { rules }) });
        break;
      case 'nested-reader':
        cases.push({ command: nested(rng, readerCommand(rng)), cwd: cwd(pick(rng, ['', 'deep/x'])) });
        break;
      case 'git': {
        const git = gitCommand(rng);
        cases.push({ command: git.command, cwd: cwd(git.cwd) });
        break;
      }
      case 'nested-git': {
        const git = gitCommand(rng);
        cases.push({ command: nested(rng, git.command), cwd: cwd(git.cwd) });
        break;
      }
      case 'hidden':
        cases.push({ command: nested(rng, pick(rng, PAYLOADS(index))) });
        break;
      default:
        cases.push({ command: mutationScript(rng, `rep${index}`, workspace.hookScript('bare')), mode: 'acceptEdits' });
    }
  }
  return cases;
};
