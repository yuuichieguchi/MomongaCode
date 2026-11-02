import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EMPTY_PROTECTED_SET, resolveCanonicalPath } from '@momonga/foundation';
import { decide } from '@momonga/policy';
import type { Decision, PolicyFilesystem } from '@momonga/policy';
import { BASH } from './decision-rows.ts';
import { TEST_SEARCH_PATH, fakeFs, fileRulesFor, isWritableFor, makeLayout } from './helpers.ts';
import type { Layout } from './helpers.ts';

type SymlinkReadLine = { program: string; argv: string[]; link: 'tree' | 'operand'; mode: 'default' | 'acceptEdits'; exit: number; readsThrough: boolean };

const LINES: readonly SymlinkReadLine[] = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'test', 'fixtures', 'symlink-reads.json'), 'utf8'),
) as SymlinkReadLine[];

const SUCCESS_EXITS: Readonly<Record<string, readonly number[]>> = { grep: [0, 1], diff: [0, 1] };

const isSuccess = (line: SymlinkReadLine): boolean => (SUCCESS_EXITS[line.program] ?? [0]).includes(line.exit);

const commandOf = (line: SymlinkReadLine): string => [line.program, ...line.argv].join(' ');

const buildLayout = (layout: Layout): void => {
  fs.mkdirSync(path.join(layout.outside, 'out', 'd'), { recursive: true });
  fs.writeFileSync(path.join(layout.outside, 'out', 's'), 'TOPSECRET x\n');
  fs.writeFileSync(path.join(layout.outside, 'out', 'd', 'f'), 'TOPSECRET x\n');
  for (const tree of ['a', 'b']) fs.mkdirSync(path.join(layout.project, tree));
  fs.symlinkSync(path.join(layout.outside, 'out', 's'), path.join(layout.project, 'a', 'l'));
  fs.symlinkSync(path.join(layout.outside, 'out', 'd'), path.join(layout.project, 'a', 'ld'));
  fs.writeFileSync(path.join(layout.project, 'a', 'x'), 'TOPSECRET\n');
  for (const name of ['l', 'x']) fs.writeFileSync(path.join(layout.project, 'b', name), 'plain\n');
};

const decideLine = (line: SymlinkReadLine, filesystem?: (layout: Layout) => PolicyFilesystem): { decision: Decision; layout: Layout } => {
  const layout = makeLayout();
  buildLayout(layout);
  const decision = decide({
    tool: BASH,
    subject: { kind: 'command', tool: 'Bash', command: commandOf(line) },
    mode: line.mode,
    rules: [],
    roots: [layout.project],
    home: layout.home,
    cwd: layout.project,
    fileRules: fileRulesFor([], [layout.project]),
    fs: filesystem?.(layout) ?? fakeFs(), searchPath: TEST_SEARCH_PATH, isWritable: isWritableFor([layout.project]),
    protectedSet: EMPTY_PROTECTED_SET,
  });
  return { decision, layout };
};

describe('approval agrees with the real tool on tree lines (5.2a)', () => {
  for (const line of LINES.filter((entry) => entry.link === 'tree')) {
    if (isSuccess(line)) {
      it(`${commandOf(line)} in ${line.mode} is approved iff it does not read through the link`, () => {
        expect(decideLine(line).decision.kind === 'allow').toBe(!line.readsThrough);
      });
    } else {
      it(`${commandOf(line)} (error exit ${line.exit}) is approved only if it does not read through the link`, () => {
        const approved = decideLine(line).decision.kind === 'allow';
        expect(approved && line.readsThrough).toBe(false);
      });
    }
  }
});

describe('operands are resolved through fs.canonicalise (3.3 rule 7)', () => {
  for (const line of LINES.filter((entry) => entry.link === 'operand')) {
    it(`${commandOf(line)} resolves its operand through the port and asks`, () => {
      const seen: string[] = [];
      const { decision, layout } = decideLine(line, () =>
        fakeFs({
          overrides: {
            canonicalise: (absolute) => {
              seen.push(absolute);
              return resolveCanonicalPath(absolute);
            },
          },
        }),
      );
      expect(seen).toContain(path.join(layout.project, line.argv.at(-1) as string));
      expect(decision.kind).toBe('ask');
    });
  }
});

describe('every follows-symlinks option appears on a line that reads through', () => {
  const readingLines = LINES.filter((line) => line.readsThrough);

  const hasOption = (line: SymlinkReadLine, option: string): boolean =>
    option.startsWith('--') || option.length > 2
      ? line.argv.includes(option)
      : line.argv.some((word) => /^-[A-Za-z]+$/.test(word) && word.includes(option.slice(1)));

  it.each([
    ['ls', '-L'],
    ['du', '-L'],
    ['find', '-L'],
    ['find', '-follow'],
    ['cp', '-L'],
    ['stat', '-L'],
    ['diff', '-r'],
    ['diff', '--recursive'],
  ])('%s %s', (program, option) => {
    expect(readingLines.some((line) => line.program === program && hasOption(line, option))).toBe(true);
  });

  it('grep -S together with -R or -r', () => {
    expect(readingLines.some((line) => line.program === 'grep' && line.link === 'tree' && hasOption(line, '-S') && (hasOption(line, '-R') || hasOption(line, '-r')))).toBe(true);
  });
});
