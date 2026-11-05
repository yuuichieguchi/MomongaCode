import path from 'node:path';
import type { RunEvent } from '@momonga/protocol';
import type { VerifiedSuccessInput } from './verified-success.ts';
import { VERIFIED_SUCCESS_EVENT_TYPES, createVerifiedSuccessFold } from './verified-success.ts';

export type RepositoryFact = {
  command: string;
  text: string;
  kind: 'procedure';
  check: { callId: string; seq: number };
  manifestPaths: string[];
};

export const repositoryFactText = (command: string): string => `Run \`${command}\` to verify a change in this repository.`;

export const REPOSITORY_FACTS_EVENT_TYPES = VERIFIED_SUCCESS_EVENT_TYPES;

export type RepositoryFactsFold = {
  add(event: RunEvent): void;
  finish(status: string): { verified: boolean; facts: RepositoryFact[] };
};

export const createRepositoryFactsFold = (input: Pick<VerifiedSuccessInput, 'commands' | 'manifests'>): RepositoryFactsFold => {
  const verdict = createVerifiedSuccessFold(input);
  const manifests = new Set(input.manifests);
  const read = new Set<string>();
  const add = (event: RunEvent): void => {
    verdict.add(event);
    if (event.type !== 'tool.completed') return;
    for (const file of event.files ?? []) {
      if (file.access === 'read' && manifests.has(path.basename(file.path))) read.add(file.path);
    }
  };
  const finish = (status: string): { verified: boolean; facts: RepositoryFact[] } => {
    const { verified, passingChecks } = verdict.finish(status);
    if (!verified) return { verified, facts: [] };
    const manifestPaths = [...read];
    return {
      verified,
      facts: passingChecks.map(({ command, callId, seq }) => ({
        command,
        text: repositoryFactText(command),
        kind: 'procedure',
        check: { callId, seq },
        manifestPaths: [...manifestPaths],
      })),
    };
  };
  return { add, finish };
};

export const repositoryFactsOf = (input: VerifiedSuccessInput): RepositoryFact[] => {
  const fold = createRepositoryFactsFold(input);
  for (const event of input.events) fold.add(event);
  return fold.finish(input.status).facts;
};
