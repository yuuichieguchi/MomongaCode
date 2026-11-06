import { describe, expect, it } from 'vitest';
import { renderWorkingState } from '@momonga/context';
import type { CommandFact, RunState, WorkingFacts, WrittenFact } from '@momonga/protocol';
import { initialRunState } from '@momonga/store';

const tokensOf = (text: string): number => Math.ceil(text.length / 4);
const READERS = { history_range: 'HistoryRead' } as const;

const stateWith = (facts: Partial<WorkingFacts>): RunState => {
  const base = initialRunState({ runId: 'run-effects', sessionId: 'session-effects' });
  return {
    ...base,
    summary: { item: { type: 'message', role: 'user', content: 'summary' }, summary: 'summary', replacedThroughSeq: 1 },
    workingFacts: { ...base.workingFacts, replacedThroughEventSeq: 9, ...facts },
  };
};

const render = (state: RunState, capTokens = 4096): string => {
  const text = renderWorkingState(state, { capTokens, tokensOf, verificationCommands: ['npm test'], readers: READERS });
  if (text === undefined) throw new Error('no working state rendered');
  return text;
};

const removed = (path: string, seq: number): WrittenFact => ({ path, removed: true, seq }) as WrittenFact;
const command = (fact: Partial<CommandFact> & { command: string; seq: number }): CommandFact => ({ failed: true, exitCode: 1, ...fact }) as CommandFact;

describe('the working state renders observed file effects', () => {
  it('renders a removed file as removed, with no hash', () => {
    const text = render(stateWith({ written: [removed('/p/old.ts', 3)] }));
    expect(text).toContain('file removed: /p/old.ts');
    expect(text).not.toContain('file written: /p/old.ts');
    expect(text).not.toMatch(/\/p\/old\.ts, sha256/);
  });

  it('says file effects were not observed after an unobserved command', () => {
    const text = render(stateWith({ commands: [command({ command: 'make fmt', seq: 4, unobserved: true } as Partial<CommandFact> & { command: string; seq: number })] }));
    expect(text).toMatch(/command failed: `make fmt`, exit code 1, file effects not observed$/m);
  });

  it('says file effects were not observed after an unobserved verification command', () => {
    const text = render(stateWith({ commands: [command({ command: 'npm test', failed: false, exitCode: 0, seq: 4, unobserved: true } as Partial<CommandFact> & { command: string; seq: number })] }));
    expect(text).toMatch(/last verification: `npm test`, exit code 0, file effects not observed$/m);
  });

  it('says the window was shared after a command observed beside a background job or a child run', () => {
    const text = render(stateWith({ commands: [command({ command: 'sed -i s/a/b/ x.ts', seq: 5, windowShared: true } as Partial<CommandFact> & { command: string; seq: number })] }));
    expect(text).toMatch(/command failed: `sed -i s\/a\/b\/ x\.ts`, exit code 1, window shared with a background job or a child run$/m);
    expect(text).not.toContain('file effects not observed');
  });

  it('adds no clause to an observed command whose window was its own', () => {
    const text = render(stateWith({ commands: [command({ command: 'make lint', seq: 5 })] }));
    expect(text).toMatch(/command failed: `make lint`, exit code 1$/m);
  });

  it('counts the new entries in the cap like any entry', () => {
    const state = stateWith({
      written: [removed('/p/gone.ts', 3)],
      commands: [
        command({ command: 'make a', seq: 4, unobserved: true } as Partial<CommandFact> & { command: string; seq: number }),
        command({ command: 'make b', seq: 5, windowShared: true } as Partial<CommandFact> & { command: string; seq: number }),
      ],
    });
    const full = render(state);
    const mandatory = full.split('\n').filter((line) => line.startsWith('replaced:'));
    expect(mandatory).toHaveLength(1);
    const tight = render(state, tokensOf(`${mandatory[0]}\nomitted 3 older entries: seq 3-5`));
    expect(tight).toContain('omitted 3 older entries: seq 3-5');
    expect(tight).not.toContain('file removed');
    expect(tight).not.toContain('not observed');
  });
});
