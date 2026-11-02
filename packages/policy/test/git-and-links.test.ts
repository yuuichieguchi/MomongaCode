import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GIT_AND_LINK_ROWS, PROTECTED_ROWS, cellAt, columnModes, commandRow, contextOf, decideRow, kindIn, P, validGitDirectory } from './decision-rows.ts';
import type { Row } from './decision-rows.ts';
import { touch } from './helpers.ts';

const rowsTable = (title: string, rows: readonly Row[]): void => {
  describe(title, () => {
    for (const row of rows) {
      for (const mode of columnModes(row)) {
        it(`${row.id} ${row.command ?? 'Write tool'} in ${mode} -> ${cellAt(row, mode)}${row.pin ? ' (pin)' : ''}`, () => {
          expect(kindIn(row, mode)).toBe(cellAt(row, mode));
        });
      }
    }
  });
};

rowsTable('4.3 git discovery, symlink and port-error rows', GIT_AND_LINK_ROWS);
rowsTable('4.4 protected .git rows', PROTECTED_ROWS);

const writeRow = (target: (layout: Parameters<NonNullable<Row['write']>>[0]) => string, extra: Partial<Row> = {}): Row => ({
  id: 'write',
  write: target,
  after: ['ask', 'allow', 'deny', 'allow'],
  pin: false,
  protection: true,
  ...extra,
});

describe('.git name components', () => {
  it('asks for a Write to .git/commondir in acceptEdits as a protected write', () => {
    const row = writeRow((layout) => P(layout, '.git', 'commondir'), { prepare: (layout) => void touch(P(layout, '.git', 'config')) });
    expect(decideRow(row, 'acceptEdits')).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('asks for a Write to a nested sub/.git/config as a protected write', () => {
    const row = writeRow((layout) => P(layout, 'sub', '.git', 'config'));
    expect(decideRow(row, 'acceptEdits')).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it.each(['.gitignore', '.github/workflows/ci.yml', 'x.git'])('allows a Write to %s in acceptEdits', (name) => {
    const row = writeRow((layout) => P(layout, name));
    expect(decideRow(row, 'acceptEdits')).toMatchObject({ kind: 'allow', source: 'mode' });
  });

  it('folds the .git component on a case-insensitive volume through the injected probe', () => {
    const folding = writeRow((layout) => P(layout, 'sub', '.GIT', 'config'), { fs: () => ({ overrides: { volumeProbe: () => true } }) });
    const exact = writeRow((layout) => P(layout, 'sub', '.GIT', 'config'), { fs: () => ({ overrides: { volumeProbe: () => false } }) });
    expect(decideRow(folding, 'acceptEdits')).toMatchObject({ kind: 'ask', source: 'protected' });
    expect(decideRow(exact, 'acceptEdits')).toMatchObject({ kind: 'allow', source: 'mode' });
  });
});

describe('GF6: a lexical target protected for approval after the obstacle changed', () => {
  it.each(['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const)('asks for a Write to x/y/config in %s', (mode) => {
    const row: Row = {
      id: 'GF6',
      write: (layout) => P(layout, 'x', 'y', 'config'),
      after: ['prot', 'prot', 'deny', 'prot'],
      pin: false,
      protection: true,
      prepare: (layout) => fs.writeFileSync(P(layout, '.git'), 'gitdir: x/y\n'),
    };
    const context = contextOf(row);
    expect(context.protectedSet.lexicalPaths).toContain(P(context.layout, 'x', 'y'));
    fs.rmSync(P(context.layout, 'x'));
    fs.mkdirSync(P(context.layout, 'x', 'y'), { recursive: true });
    const decision = decideRow(row, mode, context);
    expect(mode === 'plan' ? decision.kind : `${decision.kind}/${decision.source}`).toBe(mode === 'plan' ? 'deny' : 'ask/protected');
  });
});

describe('git approval follows repository discovery from the persisted cwd', () => {
  it('approves git status in project/sub without a .git there, as after an earlier cd sub', () => {
    const row = commandRow('git status', { cwd: (layout) => P(layout, 'sub'), prepare: (layout) => fs.mkdirSync(P(layout, 'sub')) });
    expect(kindIn(row, 'default')).toBe('allow');
  });

  it('refuses the approval in project/sub when sub/.git exists on disk (pin)', () => {
    const row = commandRow('git status', { cwd: (layout) => P(layout, 'sub'), prepare: (layout) => validGitDirectory(layout, 'sub') });
    expect(kindIn(row, 'default')).toBe('ask');
  });

  it('refuses the approval when a .git file in sub points elsewhere (pin)', () => {
    const row = commandRow('git status', {
      cwd: (layout) => P(layout, 'sub'),
      prepare: (layout) => {
        fs.mkdirSync(P(layout, 'sub'));
        fs.writeFileSync(P(layout, 'sub', '.git'), `gitdir: ${path.join(layout.outside, 'other', '.git')}\n`);
      },
    });
    expect(kindIn(row, 'default')).toBe('ask');
  });
});

describe('port errors are rethrown by decide', () => {
  const eio = (): NodeJS.ErrnoException => Object.assign(new Error('EIO: injected'), { code: 'EIO' });

  const thrownBy = (action: () => unknown): unknown => {
    try {
      action();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  it('FE4: rethrows EIO from readEntry', () => {
    const error = eio();
    const row = commandRow('git status', {
      cwd: (layout) => P(layout, 'sub'),
      prepare: (layout) => fs.mkdirSync(P(layout, 'sub')),
      fs: () => ({
        overrides: {
          readEntry: () => {
            throw error;
          },
        },
      }),
    });
    expect(thrownBy(() => decideRow(row, 'default'))).toBe(error);
  });

  it('FE5: rethrows EIO from expandGlob', () => {
    const error = eio();
    const row = commandRow('cat *', {
      fs: () => ({
        overrides: {
          expandGlob: () => {
            throw error;
          },
        },
      }),
    });
    expect(thrownBy(() => decideRow(row, 'default'))).toBe(error);
  });

  it('FE6: rethrows EIO from resolveProgram', () => {
    const error = eio();
    const row = commandRow('ls', {
      fs: () => ({
        overrides: {
          resolveProgram: () => {
            throw error;
          },
        },
      }),
    });
    expect(thrownBy(() => decideRow(row, 'default'))).toBe(error);
  });
});
