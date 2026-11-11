import { describe, expect, it } from 'vitest';
import { LITERAL_ROWS, cellAt, columnModes, commandRow, decideRow, kindIn } from './decision-rows.ts';
import { touch } from './helpers.ts';

describe('4.3 literal prefix matching rows (D14)', () => {
  for (const row of LITERAL_ROWS) {
    for (const mode of columnModes(row)) {
      it(`${row.id} ${row.command} in ${mode} -> ${cellAt(row, mode)}${row.pin ? ' (pin)' : ''}`, async () => {
        expect(await kindIn(row, mode)).toBe(cellAt(row, mode));
      });
    }
  }
});

describe('compound commands', () => {
  it('allows a compound command when every segment has a rule (pin)', async () => {
    const row = commandRow('npm test && npm run build', { rules: [['allow', 'Bash(npm test:*)'], ['allow', 'Bash(npm run build:*)']] });
    expect(await kindIn(row, 'manual')).toBe('allow');
  });

  it('asks when one segment has no rule (pin)', async () => {
    const row = commandRow('npm test && npm run build', { rules: [['allow', 'Bash(npm test:*)']] });
    expect(await kindIn(row, 'manual')).toBe('ask');
  });

  it('asks for a substitution body and lets an ask rule fire inside it (pin)', async () => {
    expect(await kindIn(commandRow('echo "$(git clean -f)"'), 'manual')).toBe('ask');
    const decision = await decideRow(commandRow('echo "$(git clean -f)"', { rules: [['allow', 'Bash(echo:*)'], ['ask', 'Bash(git clean:*)']] }), 'manual');
    expect(decision).toMatchObject({ kind: 'ask', source: 'rule' });
    expect((await decision).rule?.text).toBe('Bash(git clean:*)');
  });
});

describe('wrapper stripping', () => {
  it('does not strip the query form command -v', async () => {
    expect(await kindIn(commandRow('command -v git', { rules: [['allow', 'Bash(git:*)']] }), 'manual')).toBe('ask');
  });

  it.each(['time npm test', 'time -p npm test', 'nohup npm test', 'noglob npm test', 'command npm test', 'builtin npm test', 'stdbuf -o0 npm test'])(
    'strips the wrapper of %s for Bash(npm test:*)',
    async (command) => {
      const decision = await decideRow(commandRow(command, { rules: [['allow', 'Bash(npm test:*)']] }), 'manual');
      expect(decision).toMatchObject({ kind: 'allow', source: 'rule' });
    },
  );

  it('approves nohup ls: nohup is stripped and has no effect on the piped stdio', async () => {
    expect(await decideRow(commandRow('nohup ls'), 'manual')).toMatchObject({ kind: 'allow', reason: expect.stringContaining('read-only command') });
  });

  it('does not approve nohup ./ls', async () => {
    expect(await kindIn(commandRow('nohup ./ls', { prepare: (layout) => void touch(`${layout.project}/ls`) }), 'manual')).toBe('ask');
  });

  it('does not strip parallel for rules of the inner command', async () => {
    expect(await kindIn(commandRow('parallel grep x ::: a', { rules: [['allow', 'Bash(grep:*)']] }), 'manual')).toBe('ask');
  });
});
