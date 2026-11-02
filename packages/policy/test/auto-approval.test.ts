import { describe, expect, it } from 'vitest';
import { MAX_APPROVABLE_COMMAND_CHARS } from '@momonga/policy';
import { ACCEPT_EDITS_ROWS, READ_ONLY_ROWS, cellAt, columnModes, commandRow, decideRow, kindIn, rowById } from './decision-rows.ts';
import { touch } from './helpers.ts';
import path from 'node:path';

describe('4.1 acceptEdits approval rows', () => {
  for (const row of ACCEPT_EDITS_ROWS) {
    for (const mode of columnModes(row)) {
      it(`${row.id} ${row.command} in ${mode} -> ${cellAt(row, mode)}${row.pin ? ' (pin)' : ''}`, () => {
        expect(kindIn(row, mode)).toBe(cellAt(row, mode));
      });
    }
  }
});

describe('4.2 read-only approval rows', () => {
  for (const row of READ_ONLY_ROWS) {
    for (const mode of columnModes(row)) {
      it(`${row.id} ${row.command} in ${mode} -> ${cellAt(row, mode)}${row.pin ? ' (pin)' : ''}`, () => {
        expect(kindIn(row, mode)).toBe(cellAt(row, mode));
      });
    }
  }
});

describe('5.1.1 an undeclared option is never approved', () => {
  it.each([
    ['rm --frobnicate x'],
    ['ls --frobnicate'],
    ['sed --posix -n 1p f'],
  ])('%s asks in default and acceptEdits (pin)', (command) => {
    expect(kindIn(commandRow(command), 'default')).toBe('ask');
    expect(kindIn(commandRow(command), 'acceptEdits')).toBe('ask');
  });

  it('approves the declared forms of the same programs', () => {
    expect(kindIn(commandRow('rm x'), 'acceptEdits')).toBe('allow');
    expect(kindIn(commandRow('ls'), 'default')).toBe('allow');
    expect(kindIn(commandRow('sed -n 1p f'), 'default')).toBe('allow');
  });
});

describe('5.1.2 an unmodeled program is never approved', () => {
  it.each(['A13', 'A14'])('%s asks in default and acceptEdits (pin)', (id) => {
    expect(kindIn(rowById(id), 'default')).toBe('ask');
    expect(kindIn(rowById(id), 'acceptEdits')).toBe('ask');
  });

  it('still matches a rule literally (pin)', () => {
    const row = commandRow('mytool --format=json', { rules: [['allow', 'Bash(mytool:*)']] });
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
      const decision = decideRow(row, mode);
      expect(decision.kind).toBe('allow');
      expect(decision.source).toBe('rule');
    }
  });
});

describe('5.1.3 a modeled program whose targets lie inside the roots is approved', () => {
  it.each(['A1', 'A2', 'A3', 'A7', 'A9', 'A10', 'A15', 'A16', 'A25'])('%s is allowed in acceptEdits with the acceptEdits reason', (id) => {
    const decision = decideRow(rowById(id), 'acceptEdits');
    expect(decision.kind).toBe('allow');
    expect(decision.source).toBe('mode');
  });

  it.each(['R1', 'R3', 'R4', 'R7', 'R11', 'R13', 'R17', 'R19', 'R22', 'R24', 'R28'])('%s is allowed in default and acceptEdits as a read-only command', (id) => {
    for (const mode of ['default', 'acceptEdits'] as const) {
      const decision = decideRow(rowById(id), mode);
      expect(decision.kind).toBe('allow');
      expect(decision.reason).toContain('read-only command');
    }
  });

  it('names the acceptEdits reason for an edit-set command', () => {
    expect(decideRow(rowById('A1'), 'acceptEdits').reason).toContain('acceptEdits mode allows filesystem commands inside the workspace');
  });
});

describe('5.1.4 platform keying with the injected resolver', () => {
  it('does not approve sed resolved outside /bin and /usr/bin (A26, pin)', () => {
    expect(kindIn(rowById('A26'), 'default')).toBe('ask');
    expect(kindIn(rowById('A26'), 'acceptEdits')).toBe('ask');
  });

  it('approves sed resolved to /usr/bin/sed', () => {
    expect(kindIn(commandRow('sed -n 1p f', { fs: () => ({ programs: { sed: '/usr/bin/sed' } }) }), 'default')).toBe('allow');
  });

  it("treats /bin/rm as Apple's rm and not ./rm", () => {
    const noResolution = { fs: () => ({ programs: {} }) };
    expect(kindIn(commandRow('/bin/rm x', noResolution), 'acceptEdits')).toBe('allow');
    expect(kindIn(commandRow('./rm x', { ...noResolution, prepare: (layout) => void touch(path.join(layout.project, 'rm')) }), 'acceptEdits')).toBe('ask');
  });

  it.each(['echo hi', 'pwd', 'cd src'])('approves the builtin %s without any resolution', (command) => {
    expect(kindIn(commandRow(command, { fs: () => ({ programs: {} }) }), 'default')).toBe('allow');
  });

  it('approves only builtins when the resolver resolves nothing', () => {
    const nothing = { fs: () => ({ programs: {} }) };
    expect(kindIn(commandRow('ls', nothing), 'default')).toBe('ask');
    expect(kindIn(commandRow('cat README.md', nothing), 'default')).toBe('ask');
    expect(kindIn(commandRow('echo hi', nothing), 'default')).toBe('allow');
  });
});

describe('5.1.5 the doc exceptions each ask', () => {
  it.each(['R5', 'R6', 'R8', 'R9', 'R10', 'R12', 'R14', 'R16', 'R20', 'R21', 'R23', 'R26', 'R27', 'R29', 'R30'])('%s asks in default and acceptEdits (pin)', (id) => {
    expect(kindIn(rowById(id), 'default')).toBe('ask');
    expect(kindIn(rowById(id), 'acceptEdits')).toBe('ask');
  });

  it('R31: a command longer than MAX_APPROVABLE_COMMAND_CHARS asks', () => {
    expect(MAX_APPROVABLE_COMMAND_CHARS).toBe(10_000);
    const row = commandRow(`echo ${'x'.repeat(MAX_APPROVABLE_COMMAND_CHARS + 1 - 'echo '.length)}`);
    expect(row.command).toHaveLength(MAX_APPROVABLE_COMMAND_CHARS + 1);
    expect(kindIn(row, 'default')).toBe('ask');
    expect(kindIn(row, 'acceptEdits')).toBe('ask');
    const atLimit = commandRow(`echo ${'x'.repeat(MAX_APPROVABLE_COMMAND_CHARS - 'echo '.length)}`);
    expect(kindIn(atLimit, 'default')).toBe('allow');
  });

  it.each(['watch ls', 'setsid ls', 'ionice ls', 'flock f ls'])('the exec wrapper %s asks (pin)', (command) => {
    expect(kindIn(commandRow(command), 'default')).toBe('ask');
    expect(kindIn(commandRow(command), 'acceptEdits')).toBe('ask');
  });
});

describe('5.1.6 the edit-set still-prompt list', () => {
  it.each(['A4', 'A5', 'A6', 'A8', 'A17', 'A18', 'A19', 'A22', 'A23', 'A24'])('%s asks in acceptEdits', (id) => {
    expect(decideRow(rowById(id), 'acceptEdits').kind).toBe('ask');
  });

  it.each(['A4', 'A22'])('%s asks as a protected write in bypassPermissions', (id) => {
    expect(decideRow(rowById(id), 'bypassPermissions')).toMatchObject({ kind: 'ask', source: 'protected' });
  });

  it('asks for mkdir with a redirect to a ~ target (pin)', () => {
    expect(kindIn(commandRow('mkdir a > ~/n.txt'), 'acceptEdits')).toBe('ask');
  });
});

describe('5.1.7 critical removal covers every recursive delete effect', () => {
  it.each(['A6'])('%s asks in default and acceptEdits (pin)', (id) => {
    expect(kindIn(rowById(id), 'default')).toBe('ask');
    expect(kindIn(rowById(id), 'acceptEdits')).toBe('ask');
  });

  it.each([
    ['rmdir .', 'Bash(rmdir:*)'],
    ['find . -delete', 'Bash(find:*)'],
    ['rsync --delete a/ .', 'Bash(rsync:*)'],
    ['git clean -fdx', 'Bash(git:*)'],
    ['git reset --hard', 'Bash(git:*)'],
    ['git checkout .', 'Bash(git:*)'],
    ['rm -rf .', 'Bash(rm:*)'],
  ])('%s under %s asks in default and acceptEdits because it removes the workspace', (command, rule) => {
    const row = commandRow(command, { rules: [['allow', rule]] });
    for (const mode of ['default', 'acceptEdits'] as const) {
      const decision = decideRow(row, mode);
      expect(decision.kind).toBe('ask');
      expect(decision.reason).toContain('removes the workspace');
    }
    expect(decideRow(row, 'bypassPermissions').kind).toBe('allow');
  });
});
