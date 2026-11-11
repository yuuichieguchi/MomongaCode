import type { RuntimeStore } from '@momonga/store';
import { journalReaderPreparer } from '../worker/harness.ts';

export const withInProcessFacts = (store: RuntimeStore, dbPath: string): RuntimeStore => {
  const { inheritPlan, inheritedWindow, verdict, evidence, reflectionInput, fidelity, report, runState } = journalReaderPreparer(dbPath);
  return { ...store, journalFacts: { inheritPlan, inheritedWindow, verdict, evidence, reflectionInput, fidelity, report, runState } };
};
