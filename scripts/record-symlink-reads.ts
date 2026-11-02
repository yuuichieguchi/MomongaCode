import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandSpecsFor } from '@momonga/policy';
import { SECRET_CONTENT, SECRET_ENTRY, buildSymlinkLayout } from '../packages/tools/test/symlink-layout.ts';
import type { SymlinkReadLine } from '../packages/tools/test/symlink-layout.ts';

const SEARCH_PATH = ['/usr/bin', '/bin'];
const SUCCESS_EXITS: Readonly<Record<string, readonly number[]>> = { grep: [0, 1], diff: [0, 1] };
const USAGE_ERROR = /invalid option|unrecognized option|illegal option|invalid argument|invalid .* argument|unknown option|^usage:/im;

const GREP_FAMILY: ReadonlySet<string> = new Set(['egrep', 'fgrep']);

type Template = Pick<SymlinkReadLine, 'argv' | 'link' | 'mode'>;

const TEMPLATES: Readonly<Record<string, (option: string) => Template>> = {
  grep: (option) => ({ argv: [option, 'x', 'a'], link: 'tree', mode: 'default' }),
  ls: (option) => ({ argv: ['-R', option, 'a'], link: 'tree', mode: 'default' }),
  du: (option) => ({ argv: ['-a', option, 'a'], link: 'tree', mode: 'default' }),
  find: (option) => ({ argv: option.length === 2 ? [option, 'a'] : ['a', option], link: 'tree', mode: 'default' }),
  cp: (option) => ({ argv: ['-R', option, 'a', 'd'], link: 'tree', mode: 'acceptEdits' }),
  stat: (option) => ({ argv: [option, 'a/l'], link: 'operand', mode: 'default' }),
  diff: (option) => ({ argv: [option, 'a', 'b'], link: 'tree', mode: 'default' }),
};

const WITHOUT_FOLLOWING: ReadonlyArray<readonly [string, readonly string[], 'tree' | 'operand', 'default' | 'acceptEdits']> = [
  ['diff', ['-r', '--no-dereference', 'a', 'b'], 'tree', 'default'],
  ['diff', ['--recursive', '--no-dereference', 'a', 'b'], 'tree', 'default'],
  ['grep', ['-r', 'x', 'a'], 'tree', 'default'],
  ['grep', ['--recursive', 'x', 'a'], 'tree', 'default'],
  ['grep', ['-d', 'recurse', 'x', 'a'], 'tree', 'default'],
  ['ls', ['-R', 'a'], 'tree', 'default'],
  ['ls', ['-RH', 'a'], 'tree', 'default'],
  ['du', ['-a', 'a'], 'tree', 'default'],
  ['du', ['-aH', 'a'], 'tree', 'default'],
  ['du', ['-aP', 'a'], 'tree', 'default'],
  ['find', ['a'], 'tree', 'default'],
  ['find', ['-H', 'a'], 'tree', 'default'],
  ['find', ['-P', 'a'], 'tree', 'default'],
  ['cp', ['-R', 'a', 'd'], 'tree', 'acceptEdits'],
  ['cp', ['-RH', 'a', 'd'], 'tree', 'acceptEdits'],
  ['cp', ['-RP', 'a', 'd'], 'tree', 'acceptEdits'],
  ['cp', ['-a', 'a', 'd'], 'tree', 'acceptEdits'],
  ['grep', ['x', 'a/l'], 'operand', 'default'],
  ['grep', ['-R', 'x', 'a/l'], 'operand', 'default'],
  ['grep', ['-R', 'x', 'a/ld'], 'operand', 'default'],
  ['ls', ['-R', 'a/ld'], 'operand', 'default'],
  ['ls', ['-RH', 'a/ld'], 'operand', 'default'],
  ['du', ['-a', 'a/ld'], 'operand', 'default'],
  ['du', ['-aH', 'a/ld'], 'operand', 'default'],
  ['find', ['a/ld'], 'operand', 'default'],
  ['find', ['-H', 'a/ld'], 'operand', 'default'],
  ['stat', ['a/l'], 'operand', 'default'],
];

const markedLines = (): Array<Template & { program: string }> =>
  commandSpecsFor('linux').all.flatMap((spec) => {
    const options = spec.options.filter((option) => option.effect === 'follows-symlinks');
    if (options.length === 0) return [];
    return spec.names.flatMap((program) => {
      const template = TEMPLATES[GREP_FAMILY.has(program) ? 'grep' : program];
      if (template === undefined) throw new Error(`${program} has a follows-symlinks option in the GNU table and no template in this script`);
      return options.map((option) => ({ program, ...template(option.name) }));
    });
  });

const unmeasuredLines = (): Array<Template & { program: string }> => {
  const lines = [
    ...markedLines(),
    ...WITHOUT_FOLLOWING.map(([program, argv, link, mode]) => ({ program, argv: [...argv], link, mode })),
  ];
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = `${line.program} ${line.argv.join(' ')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const resolveTool = (program: string): string => {
  const found = SEARCH_PATH.map((directory) => path.join(directory, program)).find((candidate) => fs.existsSync(candidate));
  if (found === undefined) throw new Error(`${program} is not in ${SEARCH_PATH.join(':')}`);
  return found;
};

const withTree = (argv: readonly string[], tree: string): string[] => argv.map((word) => word.replace(/^a(?=\/|$)/, tree));

const run = (dir: string, program: string, argv: readonly string[]) =>
  spawnSync(resolveTool(program), argv, { cwd: dir, encoding: 'utf8', env: { PATH: SEARCH_PATH.join(':'), LANG: 'C' } });

const showsMarker = (dir: string, line: SymlinkReadLine, tree: 'a' | 'c', output: string): boolean => {
  if (line.program === 'cp') {
    const copied = path.join(dir, 'd', 'l');
    return fs.existsSync(copied) && !fs.lstatSync(copied).isSymbolicLink() && fs.readFileSync(copied, 'utf8') === SECRET_CONTENT;
  }
  if (line.program === 'stat') {
    const behind = tree === 'a' ? path.join(dir, 'out', 's') : path.join(dir, 'c', 'l');
    return output.includes(String(fs.statSync(behind).ino));
  }
  return output.includes(SECRET_CONTENT.trim()) || output.includes(SECRET_ENTRY);
};

const inFreshLayout = <T>(use: (dir: string) => T): T => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-record-')));
  try {
    buildSymlinkLayout(dir);
    return use(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const measure = (given: Template & { program: string }): SymlinkReadLine =>
  inFreshLayout((dir) => {
    const line = { ...given, exit: 0, readsThrough: false };
    const label = `${line.program} ${line.argv.join(' ')}`;
    const result = run(dir, line.program, line.argv);
    if (result.status === null) throw new Error(`${label} was killed by ${String(result.signal)}`);
    if (USAGE_ERROR.test(result.stderr)) throw new Error(`${label} is not a command of this tool: ${result.stderr.trim()}`);
    const succeeded = (SUCCESS_EXITS[line.program] ?? [0]).includes(result.status);
    if (!succeeded) throw new Error(`${label} failed with exit ${result.status}: ${result.stderr.trim()}`);
    const controlReads = inFreshLayout((control) => {
      const controlResult = run(control, line.program, withTree(line.argv, 'c'));
      return showsMarker(control, line, 'c', `${controlResult.stdout}${controlResult.stderr}`);
    });
    if (!controlReads) throw new Error(`${label} shows no marker on the control tree, so its measurement means nothing`);
    return { ...line, exit: result.status, readsThrough: showsMarker(dir, line, 'a', `${result.stdout}${result.stderr}`) };
  });

process.stdout.write(`${JSON.stringify(unmeasuredLines().map(measure), null, 2)}\n`);
