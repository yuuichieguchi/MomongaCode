import path from 'node:path';
import { lexicallyWithin } from '@momonga/foundation';
import type { MemoryEvidence, MemoryStatus } from '@momonga/protocol';

export class EvidenceOutsideRootError extends Error {
  constructor(target: string) {
    super(`${target} resolves outside the project root`);
    this.name = 'EvidenceOutsideRootError';
  }
}

export type EvidencePorts = {
  hashFile(absolutePath: string): Promise<string | undefined>;
  isAncestor(sha: string): Promise<boolean | undefined>;
};

export type MemoryStatusContext = { project: string; trusted: boolean; ports: EvidencePorts };

type Finding = 'matches' | 'contradicts' | 'unchecked';

const fileFinding = async (entry: Extract<MemoryEvidence, { kind: 'file' }>, context: MemoryStatusContext): Promise<Finding> => {
  if (!context.trusted || entry.project !== context.project) return 'unchecked';
  const resolved = path.resolve(context.project, entry.path);
  if (!lexicallyWithin(resolved, context.project)) return 'unchecked';
  let hash: string | undefined;
  try {
    hash = await context.ports.hashFile(resolved);
  } catch (error) {
    if (error instanceof EvidenceOutsideRootError) return 'unchecked';
    throw error;
  }
  return hash === entry.sha256 ? 'matches' : 'contradicts';
};

const commitIsAncestor = async (entries: readonly Extract<MemoryEvidence, { kind: 'commit' }>[], context: MemoryStatusContext): Promise<boolean> => {
  if (!context.trusted) return false;
  const answers = await Promise.all(entries.map((entry) => context.ports.isAncestor(entry.sha)));
  return answers.every((answer) => answer === true);
};

export const memoryStatus = async (memory: { evidence: readonly MemoryEvidence[] }, context: MemoryStatusContext): Promise<MemoryStatus> => {
  const files = memory.evidence.filter((entry): entry is Extract<MemoryEvidence, { kind: 'file' }> => entry.kind === 'file');
  if (files.length > 0) {
    const findings = await Promise.all(files.map((entry) => fileFinding(entry, context)));
    if (findings.includes('contradicts')) return 'stale';
    return findings.includes('unchecked') ? 'unverifiable' : 'verified';
  }
  const commits = memory.evidence.filter((entry): entry is Extract<MemoryEvidence, { kind: 'commit' }> => entry.kind === 'commit');
  if (commits.length === 0) return 'unbound';
  return (await commitIsAncestor(commits, context)) ? 'unbound' : 'unverifiable';
};
