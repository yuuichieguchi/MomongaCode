import path from 'node:path';
import type { VerifiedSuccessInput } from './verified-success.ts';
import { analyseVerifiedSuccess } from './verified-success.ts';

export type RepositoryFact = {
  command: string;
  text: string;
  kind: 'procedure';
  check: { callId: string; seq: number };
  manifestPaths: string[];
};

export const repositoryFactText = (command: string): string => `Run \`${command}\` to verify a change in this repository.`;

const manifestsRead = (input: VerifiedSuccessInput): string[] => {
  const manifests = new Set(input.manifests);
  const read = new Set<string>();
  for (const event of input.events) {
    if (event.type !== 'tool.completed') continue;
    for (const file of event.files ?? []) {
      if (file.access === 'read' && manifests.has(path.basename(file.path))) read.add(file.path);
    }
  }
  return [...read];
};

export const repositoryFactsOf = (input: VerifiedSuccessInput): RepositoryFact[] => {
  const { verified, passingChecks } = analyseVerifiedSuccess(input);
  if (!verified) return [];
  const manifestPaths = manifestsRead(input);
  return passingChecks.map(({ command, callId, seq }) => ({
    command,
    text: repositoryFactText(command),
    kind: 'procedure',
    check: { callId, seq },
    manifestPaths: [...manifestPaths],
  }));
};
