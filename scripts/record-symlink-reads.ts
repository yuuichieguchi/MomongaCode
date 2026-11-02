import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SECRET_CONTENT, SECRET_ENTRY, buildSymlinkLayout, symlinkReadLinesFor } from '../packages/tools/test/symlink-layout.ts';
import type { SymlinkReadLine } from '../packages/tools/test/symlink-layout.ts';

const SEARCH_PATH = ['/usr/bin', '/bin'];
const SUCCESS_EXITS: Readonly<Record<string, readonly number[]>> = { grep: [0, 1], diff: [0, 1] };

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

const measure = (line: SymlinkReadLine): SymlinkReadLine =>
  inFreshLayout((dir) => {
    const result = run(dir, line.program, line.argv);
    if (result.status === null) throw new Error(`${line.program} ${line.argv.join(' ')} was killed by ${String(result.signal)}`);
    const succeeded = (SUCCESS_EXITS[line.program] ?? [0]).includes(result.status);
    if (succeeded) {
      const controlReads = inFreshLayout((control) => {
        const controlResult = run(control, line.program, withTree(line.argv, 'c'));
        return showsMarker(control, line, 'c', `${controlResult.stdout}${controlResult.stderr}`);
      });
      if (!controlReads) throw new Error(`${line.program} ${line.argv.join(' ')} shows no marker on the control tree, so its measurement means nothing`);
    }
    return { ...line, exit: result.status, readsThrough: showsMarker(dir, line, 'a', `${result.stdout}${result.stderr}`) };
  });

process.stdout.write(`${JSON.stringify(symlinkReadLinesFor('darwin').map(measure), null, 2)}\n`);
