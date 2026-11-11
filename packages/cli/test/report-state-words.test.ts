import { CONDITION_STATES, RESIDUAL_RISK_CODES } from '@momonga/protocol';
import type { RunReport } from '@momonga/protocol';
import { describe, expect, it } from 'vitest';
import { renderReport } from '../src/commands/report.ts';
import { CONDITION_STATE_WORDS, RESIDUAL_RISK_WORDS, unmetConditionLines } from '../src/policy-messages.ts';

const BASE: RunReport = {
  runId: 'run-1',
  status: 'COMPLETED',
  durationMs: 1200,
  declaration: { conditions: [], requirements: [] },
  changes: { files: [], mutatingCalls: 0 },
  conditions: [],
  notRun: [],
  residualRisk: [],
  modelChecks: [],
};

const IDENTIFIER = /[a-z]_[a-z]/;

describe('the report shows a state and a risk as its words, never as its identifier (cli-commands-C15)', () => {
  it('has words for every condition state and every residual risk', () => {
    expect(CONDITION_STATES.filter((state) => IDENTIFIER.test(CONDITION_STATE_WORDS[state]) || CONDITION_STATE_WORDS[state] === '')).toEqual([]);
    expect(RESIDUAL_RISK_CODES.filter((code) => IDENTIFIER.test(RESIDUAL_RISK_WORDS[code]) || RESIDUAL_RISK_WORDS[code] === '')).toEqual([]);
  });

  it('prints the words of every state in the conditions block', () => {
    const text = renderReport({ ...BASE, conditions: CONDITION_STATES.map((state, index) => ({ id: `c${index}`, command: `check-${index}`, state, rounds: 1 })) });
    const block = text.split('\n').slice(2, 2 + CONDITION_STATES.length);
    expect(block).toEqual(CONDITION_STATES.map((state, index) => `  ${CONDITION_STATE_WORDS[state]}  check-${index}  (1 round)`));
    expect(block.filter((line) => IDENTIFIER.test(line))).toEqual([]);
  });

  it('prints the words of every residual risk with its count', () => {
    const text = renderReport({ ...BASE, residualRisk: RESIDUAL_RISK_CODES.map((code, index) => ({ code, count: index + 1 })) });
    const lines = text.split('\n');
    const at = lines.indexOf('residual risk:');
    expect(lines.slice(at + 1, at + 1 + RESIDUAL_RISK_CODES.length)).toEqual(RESIDUAL_RISK_CODES.map((code, index) => `  ${RESIDUAL_RISK_WORDS[code]}  ${index + 1}`));
  });

  it('the unmet lines of a headless run use the same words', () => {
    const lines = unmetConditionLines({ ...BASE, conditions: [{ id: 'c1', command: 'npm test', state: 'stale', rounds: 1 }] });
    expect(lines).toEqual([`  unmet: npm test ${CONDITION_STATE_WORDS.stale}`]);
  });
});
