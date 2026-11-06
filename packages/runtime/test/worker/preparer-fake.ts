import type { RunEventPayload } from '@momonga/protocol';
import type { ContributionMeasured, ContributionPreparer, RuntimeStore } from '@momonga/store';
import { noJournalFacts } from '../../../store/test/helpers.ts';
import type { ServiceTimers } from '../../src/service/timers.ts';
import { journalReaderPreparer } from './harness.ts';

export type MeasureRequest = { runId: string; leading: RunEventPayload[] };

export type PreparerFake = {
  preparer: ContributionPreparer;
  requests: MeasureRequest[];
  failures: Error[];
  hold(): () => void;
  bind(store: RuntimeStore, dbPath: string): void;
};

export const MEASURED_ITEM = { kind: 'memory', id: 'measured-by-the-port', contributed: true } as const;

export const preparerFake = (): PreparerFake => {
  const requests: MeasureRequest[] = [];
  const failures: Error[] = [];
  let bound: RuntimeStore | undefined;
  let reader: ContributionPreparer | undefined;
  let gate: Promise<void> | undefined;
  const boundReader = (): ContributionPreparer => {
    if (reader === undefined) throw new Error('the preparer fake answers journal facts only after bind');
    return reader;
  };
  return {
    requests,
    failures,
    hold: () => {
      let open: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        gate = undefined;
        open();
      };
    },
    bind: (store, dbPath) => {
      bound = store;
      reader = journalReaderPreparer(dbPath);
    },
    preparer: {
      ...noJournalFacts,
      inheritPlan: async (request, signal) => boundReader().inheritPlan(request, signal),
      inheritedWindow: async (request, signal) => boundReader().inheritedWindow(request, signal),
      measure: async (request): Promise<ContributionMeasured> => {
        requests.push({ runId: request.runId, leading: [...request.leading] });
        if (gate !== undefined) await gate;
        const failure = failures.shift();
        if (failure !== undefined) throw failure;
        const run = bound?.getRun(request.runId);
        if (run === undefined) throw new Error(`the preparer fake measured an unknown run ${request.runId}`);
        return { lastSeq: run.lastSeq, contribution: { type: 'context.contribution', items: [MEASURED_ITEM] } };
      },
    },
  };
};

export const inertTimers: ServiceTimers = {
  setTimeout: () => undefined,
  clearTimeout: () => undefined,
};
