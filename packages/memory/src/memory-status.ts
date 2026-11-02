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

const commitFinding = async (entry: Extract<MemoryEvidence, { kind: 'commit' }>, context: MemoryStatusContext): Promise<Finding> => {
  if (!context.trusted) return 'unchecked';
  const ancestor = await context.ports.isAncestor(entry.sha);
  if (ancestor === undefined) return 'unchecked';
  return ancestor ? 'matches' : 'contradicts';
};

export const memoryStatus = async (memory: { evidence: readonly MemoryEvidence[] }, context: MemoryStatusContext): Promise<MemoryStatus> => {
  const findings = await Promise.all(
    memory.evidence.flatMap((entry): Promise<Finding>[] => {
      if (entry.kind === 'file') return [fileFinding(entry, context)];
      if (entry.kind === 'commit') return [commitFinding(entry, context)];
      return [];
    }),
  );
  if (findings.includes('contradicts')) return 'stale';
  if (findings.includes('unchecked')) return 'unverifiable';
  return memory.evidence.some((entry) => entry.kind === 'file') ? 'verified' : 'unbound';
};
