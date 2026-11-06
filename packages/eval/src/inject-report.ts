import type { AnsweredByView, RunFactsView } from '@momonga/protocol';
import { aggregate, buildReliabilityReport } from '@momonga/reliability';
import type { GroupKey, NotRun, ReliabilityReport, ScenarioRow } from '@momonga/reliability';
import { uniqueAnswerers } from './context-report.ts';
import type { InjectionScenarios } from './inject.ts';
import { EvalError } from './runner.ts';
import { suiteDigestOf } from './bench-report.ts';

export type InjectionTrial = {
  scenario: string;
  facts: readonly RunFactsView[];
  witness: Readonly<Record<string, number>>;
  answeredBy: readonly AnsweredByView[];
  unrecordedAnswers: number;
};

export type BuildInjectionReportInput = {
  scenarios: InjectionScenarios;
  trials: readonly InjectionTrial[];
  notRun: readonly NotRun[];
  codeDigest: string;
  groupBy: GroupKey;
};

const episodesOf = (trials: readonly InjectionTrial[]) => trials.flatMap((trial) => trial.facts.flatMap((facts) => facts.recoveries));

const hasWitness = (trial: InjectionTrial): boolean => Object.keys(trial.witness).length > 0;

const duplicated = (trial: InjectionTrial): boolean => Object.values(trial.witness).some((count) => count > 1);

export const buildInjectionReport = (input: BuildInjectionReportInput): ReliabilityReport => {
  const known = new Set(input.scenarios.scenarios.map((scenario) => scenario.id));
  const byScenario = new Map<string, InjectionTrial[]>();
  for (const trial of input.trials) {
    const base = trial.scenario.split('@')[0] as string;
    if (!known.has(base)) throw new EvalError(`a trial names the scenario ${trial.scenario}, which the scenario file does not hold`);
    byScenario.set(trial.scenario, [...(byScenario.get(trial.scenario) ?? []), trial]);
  }
  const scenarios: ScenarioRow[] = [...byScenario].map(([scenario, trials]) => {
    const episodes = episodesOf(trials);
    return { scenario, trials: trials.length, episodes: episodes.length, recovered: episodes.filter((episode) => episode.outcome === 'recovered').length };
  });
  const witnessed = input.trials.filter(hasWitness);
  return buildReliabilityReport({
    kind: 'injection',
    aggregate: aggregate(
      input.trials.flatMap((trial) => trial.facts),
      { groupBy: input.groupBy },
    ),
    harness: {
      suite: { name: input.scenarios.name, digest: suiteDigestOf(input.scenarios) },
      answeredBy: uniqueAnswerers(input.trials.flatMap((trial) => trial.answeredBy)),
      unrecordedAnswers: input.trials.reduce((sum, trial) => sum + trial.unrecordedAnswers, 0),
      codeDigest: input.codeDigest,
    },
    scenarios,
    witnessed: { k: witnessed.filter(duplicated).length, n: witnessed.length },
    notRun: [...input.notRun],
  });
};
