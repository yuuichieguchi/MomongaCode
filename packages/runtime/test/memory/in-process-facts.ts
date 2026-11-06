import type { RuntimeStore } from '@momonga/store';
import { journalReaderPreparer } from '../worker/harness.ts';

export const withInProcessFacts = (store: RuntimeStore, dbPath: string): RuntimeStore => {
  const { verdict, evidence, reflectionInput } = journalReaderPreparer(dbPath);
  return { ...store, journalFacts: { verdict, evidence, reflectionInput } };
};
