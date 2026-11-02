import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SECRET_CONTENT, SECRET_ENTRY, SYMLINK_READ_LINES, buildSymlinkLayout } from './symlink-layout.ts';
import type { SymlinkReadLine } from './symlink-layout.ts';

const SEARCH_PATH = ['/usr/bin', '/bin'];
const SUCCESS_EXITS: Readonly<Record<string, readonly number[]>> = { grep: [0, 1], diff: [0, 1] };

const resolveApple = (program: string): string | undefined =>
  SEARCH_PATH.map((directory) => path.join(directory, program)).find((candidate) => fs.existsSync(candidate));

const isSuccess = (line: SymlinkReadLine): boolean => (SUCCESS_EXITS[line.program] ?? [0]).includes(line.exit);

const expectsOutput = (line: SymlinkReadLine): boolean => line.program !== 'cp' && !(line.program === 'grep' && line.exit === 1);

const withTree = (argv: readonly string[], tree: string): string[] => argv.map((word) => word.replace(/^a(?=\/|$)/, tree));

const run = (dir: string, program: string, argv: readonly string[]) =>
  spawnSync(program, argv, { cwd: dir, encoding: 'utf8', env: { PATH: SEARCH_PATH.join(':'), LANG: 'C' } });

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

describe.runIf(process.platform === 'darwin')('recursive and link-following options against the real Apple tools (5.2a)', () => {
  let dir = '';

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sl-')));
    buildSymlinkLayout(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('has every line of the fixture', () => {
    expect(SYMLINK_READ_LINES.length).toBe(45);
  });

  for (const line of SYMLINK_READ_LINES) {
    it(`${line.program} ${line.argv.join(' ')} (${line.link}) reads through: ${String(line.readsThrough)}`, () => {
      const binary = resolveApple(line.program);
      expect(binary === `/bin/${line.program}` || binary === `/usr/bin/${line.program}`).toBe(true);

      const result = run(dir, binary as string, line.argv);
      expect(result.status).toBe(line.exit);
      const output = `${result.stdout}${result.stderr}`;
      if (expectsOutput(line)) expect(output).not.toBe('');

      if (isSuccess(line)) {
        const controlDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sl-control-')));
        try {
          buildSymlinkLayout(controlDir);
          const control = run(controlDir, binary as string, withTree(line.argv, 'c'));
          expect(showsMarker(controlDir, line, 'c', `${control.stdout}${control.stderr}`)).toBe(true);
        } finally {
          fs.rmSync(controlDir, { recursive: true, force: true });
        }
      }

      expect(showsMarker(dir, line, 'a', output)).toBe(line.readsThrough);
    });
  }
});
