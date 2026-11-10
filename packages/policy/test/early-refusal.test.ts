import { describe, expect, it } from 'vitest';
import { analyzeCommand, allWriteTargets } from '../src/shell.ts';
import { EARLY_REFUSAL_ROWS, REDIRECT_ROWS, cellAt, columnModes, commandRow, decideRow, kindIn, rowById } from './decision-rows.ts';
import type { Row } from './decision-rows.ts';

const rowsTable = (title: string, rows: readonly Row[]): void => {
  describe(title, () => {
    for (const row of rows) {
      for (const mode of columnModes(row)) {
        it(`${row.id} ${row.command} in ${mode} -> ${cellAt(row, mode)}${row.pin ? ' (pin)' : ''}`, () => {
          expect(kindIn(row, mode)).toBe(cellAt(row, mode));
        });
      }
    }
  });
};

rowsTable('4.4 early refusal of resolved targets', EARLY_REFUSAL_ROWS);
rowsTable('4.5 redirect targets and unresolvable targets', REDIRECT_ROWS);

const writeTargetsOf = (command: string) => {
  const analysis = analyzeCommand(command);
  expect(analysis).not.toBeNull();
  return allWriteTargets(analysis as NonNullable<typeof analysis>);
};

describe('candidate targets', () => {
  it('gives git checkout .env a candidate target, not a literal', () => {
    const targets = writeTargetsOf('git checkout .env');
    expect(targets).toContainEqual({ candidate: '.env', removes: true });
    expect(targets).not.toContainEqual({ literal: '.env' });
    expect(targets).not.toContainEqual({ literal: '.env', removes: true });
  });

  it('gives an operand after -- a literal write target', () => {
    expect(writeTargetsOf('git checkout -- .env')).toContainEqual({ literal: '.env', removes: true });
  });
});

describe('A21 removes a denied file in every mode', () => {
  it('denies rm .env under Write(.env) by the rule', () => {
    expect(decideRow(rowById('A21'), 'bypassPermissions')).toMatchObject({ kind: 'deny', source: 'rule' });
  });
});

describe('option-value writes of the Tier C effect specs', () => {
  it.each([
    ['curl -D h.txt -s u', 'h.txt'],
    ['curl -c jar.txt u', 'jar.txt'],
    ['curl --trace t.txt u', 't.txt'],
    ['curl --trace-ascii t.txt u', 't.txt'],
    ['curl --stderr e.txt u', 'e.txt'],
    ['curl --etag-save e.txt u', 'e.txt'],
    ['curl --libcurl c.c u', 'c.c'],
    ['rsync --log-file l.txt a b', 'l.txt'],
    ['rsync --temp-dir t a b', 't'],
    ['rsync --backup-dir bk a b', 'bk'],
    ['rsync --partial-dir p a b', 'p'],
    ['rsync --write-batch w a b', 'w'],
    ['rsync --only-write-batch w a b', 'w'],
    ['zip -O o.zip a.zip f', 'o.zip'],
    ['wget --save-cookies c.txt u', 'c.txt'],
    ['wget --warc-file w u', 'w'],
    ['wget --rejected-log r.txt u', 'r.txt'],
    ['script -O o.log', 'o.log'],
    ['script -I i.log', 'i.log'],
    ['script -B b.log', 'b.log'],
    ['script -T t.log', 't.log'],
    ['sort -o o.txt a.txt', 'o.txt'],
    ['sort -T tmpdir a.txt', 'tmpdir'],
    ['base64 -o o.txt a.txt', 'o.txt'],
    ['less -o o.txt a.txt', 'o.txt'],
    ['less -O o.txt a.txt', 'o.txt'],
    ['tree -o o.txt', 'o.txt'],
  ])('%s writes %s', (command, value) => {
    expect(writeTargetsOf(command)).toContainEqual({ literal: value });
  });
});

describe('B4 forms and unresolvable targets', () => {
  const DENY_BASHRC = [['deny', 'Write(~/.bashrc)']] as const;
  const DENY_SSH = [['deny', 'Read(~/.ssh/**)']] as const;
  const FORMS: ReadonlyArray<readonly [string, ReadonlyArray<readonly ['deny', string]>]> = [
    ['echo x > "$HOME/.bashrc"', DENY_BASHRC],
    ['echo x >$HOME/.bashrc', DENY_BASHRC],
    ['cd ~; echo x > .bashrc', DENY_BASHRC],
    ['echo x <(true) >"$HOME/.bashrc"', DENY_BASHRC],
    ['cat < $F', DENY_SSH],
    ['cat $F', DENY_SSH],
  ];

  it.each(FORMS)('%s with a deny rule asks in default and acceptEdits and is allowed in bypass', (command, rules) => {
    const row = commandRow(command, { rules });
    expect(kindIn(row, 'manual')).toBe('ask');
    expect(kindIn(row, 'acceptEdits')).toBe('ask');
    expect(kindIn(row, 'bypassPermissions')).toBe('allow');
  });

  it.each(FORMS)('%s without a deny rule asks in default and is allowed in bypass', (command) => {
    const row = commandRow(command);
    expect(kindIn(row, 'manual')).toBe('ask');
    expect(kindIn(row, 'bypassPermissions')).toBe('allow');
  });

  it.each(['C1', 'C2'])('%s names other-user-home in the reason of its ask', (id) => {
    expect(decideRow(rowById(id), 'manual').reason).toContain('other-user-home');
  });

  it('C4 names other-user-home in the reason of its ask', () => {
    expect(decideRow(rowById('C4'), 'manual').reason).toContain('other-user-home');
  });
});

describe('5.11 bypass adds no decision for unresolvable targets', () => {
  const B4_FORMS = ['echo x > "$HOME/.bashrc"', 'echo x >$HOME/.bashrc', 'cd ~; echo x > .bashrc', 'echo x <(true) >"$HOME/.bashrc"'];

  it.each(['C1', 'C2', 'C3'])('%s is allowed in bypassPermissions', (id) => {
    expect(kindIn(rowById(id), 'bypassPermissions')).toBe('allow');
  });

  it.each(B4_FORMS)('%s under Write(~/.bashrc) deny is allowed in bypassPermissions', (command) => {
    expect(kindIn(commandRow(command, { rules: [['deny', 'Write(~/.bashrc)']] }), 'bypassPermissions')).toBe('allow');
  });

  it.each([...['C1', 'C2', 'C3'].map((id) => rowById(id)), ...B4_FORMS.map((command) => commandRow(command, { rules: [['deny', 'Write(~/.bashrc)']] }))])(
    '$id asks and never denies in default and acceptEdits',
    (row) => {
      expect(kindIn(row, 'manual')).toBe('ask');
      expect(kindIn(row, 'acceptEdits')).toBe('ask');
    },
  );
});
