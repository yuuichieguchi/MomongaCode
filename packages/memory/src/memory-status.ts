import path from 'node:path';
import { lexicallyWithin } from '@momonga/foundation';
import type { MemoryEvidence, MemoryStatus, StoredMemoryEvidence } from '@momonga/protocol';

export class EvidenceOutsideRootError extends Error {
  constructor(target: string) {
    super(`${target} resolves outside the project root`);
    this.name = 'EvidenceOutsideRootError';
  }
}

export class EvidenceUnreadableError extends Error {
  constructor(target: string, options?: ErrorOptions) {
    super(`${target} could not be read`, options);
    this.name = 'EvidenceUnreadableError';
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
    if (error instanceof EvidenceOutsideRootError || error instanceof EvidenceUnreadableError) return 'unchecked';
    throw error;
  }
  return hash === entry.sha256 ? 'matches' : 'contradicts';
};

const commitIsAncestor = async (entries: readonly Extract<MemoryEvidence, { kind: 'commit' }>[], context: MemoryStatusContext): Promise<boolean> => {
  if (!context.trusted) return false;
  for (const entry of entries) {
    if ((await context.ports.isAncestor(entry.sha)) !== true) return false;
  }
  return true;
};

export const memoryStatus = async (memory: { evidence: readonly StoredMemoryEvidence[] }, context: MemoryStatusContext): Promise<MemoryStatus> => {
  const checked = await knownEvidenceStatus(memory.evidence.filter((entry): entry is MemoryEvidence => entry.kind !== 'unknown'), context);
  return checked === 'stale' || memory.evidence.every((entry) => entry.kind !== 'unknown') ? checked : 'unverifiable';
};

const knownEvidenceStatus = async (evidence: readonly MemoryEvidence[], context: MemoryStatusContext): Promise<MemoryStatus> => {
  const memory = { evidence };
  const files = memory.evidence.filter((entry): entry is Extract<MemoryEvidence, { kind: 'file' }> => entry.kind === 'file');
  if (files.length > 0) {
    let unchecked = false;
    for (const entry of files) {
      const finding = await fileFinding(entry, context);
      if (finding === 'contradicts') return 'stale';
      if (finding === 'unchecked') unchecked = true;
    }
    return unchecked ? 'unverifiable' : 'verified';
  }
  const commits = memory.evidence.filter((entry): entry is Extract<MemoryEvidence, { kind: 'commit' }> => entry.kind === 'commit');
  if (commits.length === 0) return 'unbound';
  return (await commitIsAncestor(commits, context)) ? 'unbound' : 'unverifiable';
};
