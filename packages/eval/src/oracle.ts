import type { PublicRunEvent } from '@momonga/protocol';

export const GATE_VERDICTS = ['passed', 'failed', 'not_run'] as const;

export type GateVerdict = (typeof GATE_VERDICTS)[number];

export const gateVerdictOf = (run: { status: string; stopReason?: string }, events: readonly PublicRunEvent[]): GateVerdict => {
  if (run.status === 'STOPPED' && run.stopReason === 'conditions_unmet') return 'failed';
  const checked = events.some((event) => event.type === 'verification.completed');
  return run.status === 'COMPLETED' && checked ? 'passed' : 'not_run';
};

export type Agreement = { gatePassOraclePass: number; gatePassOracleFail: number; gateFailOraclePass: number; gateFailOracleFail: number; gateNotRun: number };

export const completionAgreement = (rows: readonly { gate: GateVerdict; oracle: boolean }[]): Agreement => {
  const count = (matches: (row: { gate: GateVerdict; oracle: boolean }) => boolean): number => rows.filter(matches).length;
  return {
    gatePassOraclePass: count((row) => row.gate === 'passed' && row.oracle),
    gatePassOracleFail: count((row) => row.gate === 'passed' && !row.oracle),
    gateFailOraclePass: count((row) => row.gate === 'failed' && row.oracle),
    gateFailOracleFail: count((row) => row.gate === 'failed' && !row.oracle),
    gateNotRun: count((row) => row.gate === 'not_run'),
  };
};
