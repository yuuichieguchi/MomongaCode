import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lexicallyWithin, resolveToolPath } from '@momonga/foundation';
import { EvidenceOutsideRootError, EvidenceUnreadableError } from '@momonga/memory';
import type { EvidencePorts } from '@momonga/memory';
import type { MemoryEvidence, MemoryScope } from '@momonga/protocol';
import type { EvidenceReply } from '@momonga/store';
import { ToolExecutionError } from '@momonga/tools';

export type EvidenceCommand = {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  network: 'deny';
};

export type EvidenceCommandResult = { exitCode: number | null; stdout?: string; notStarted?: string };

export type EvidenceRun = (command: EvidenceCommand, signal: AbortSignal) => Promise<EvidenceCommandResult>;

export type EvidencePortsOptions = { project: string; trusted: boolean; run: EvidenceRun; signal: AbortSignal };

export class MemoryEvidenceError extends ToolExecutionError {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryEvidenceError';
  }
}

const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };

const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const gitCommand = (project: string, args: readonly string[]): EvidenceCommand => ({ argv: ['git', ...args], cwd: project, env: { ...GIT_ENV }, network: 'deny' });

const isMissingFile = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');

const hasErrnoCode = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string';

const sha256OfHandle = (handle: fs.promises.FileHandle): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = handle.createReadStream({ autoClose: false });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

const sha256OfRegularFile = async (real: string, original: string): Promise<string | undefined> => {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(real, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    if (hasErrnoCode(error)) throw new EvidenceUnreadableError(original, { cause: error });
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    return await sha256OfHandle(handle);
  } catch (error) {
    if (hasErrnoCode(error)) throw new EvidenceUnreadableError(original, { cause: error });
    throw error;
  } finally {
    await handle.close();
  }
};

export const createEvidencePorts = ({ project, trusted, run, signal }: EvidencePortsOptions): EvidencePorts => {
  const ancestry = new Map<string, Promise<boolean | undefined>>();
  const askAncestry = async (sha: string): Promise<boolean | undefined> => {
    if (signal.aborted) return undefined;
    const { exitCode } = await run(gitCommand(project, ['merge-base', '--is-ancestor', sha, 'HEAD']), signal);
    if (exitCode === 0) return true;
    if (exitCode === 1) return false;
    return undefined;
  };
  return {
    hashFile: async (absolutePath) => {
      let real: string;
      let root: string;
      try {
        root = await fs.promises.realpath(project);
        real = await fs.promises.realpath(absolutePath);
      } catch (error) {
        if (isMissingFile(error)) return undefined;
        if (hasErrnoCode(error)) throw new EvidenceUnreadableError(absolutePath, { cause: error });
        throw error;
      }
      if (!lexicallyWithin(real, root)) throw new EvidenceOutsideRootError(absolutePath);
      return sha256OfRegularFile(real, absolutePath);
    },
    isAncestor: (sha) => {
      if (!trusted || !COMMIT_ID.test(sha)) return Promise.resolve(undefined);
      const known = ancestry.get(sha);
      if (known !== undefined) return known;
      const asked = askAncestry(sha);
      ancestry.set(sha, asked);
      return asked;
    },
  };
};

export const readGitHead = async ({ project, trusted, run, signal }: EvidencePortsOptions): Promise<string | undefined> => {
  if (!trusted || signal.aborted) return undefined;
  const { exitCode, stdout } = await run(gitCommand(project, ['rev-parse', 'HEAD']), signal);
  const head = stdout?.trim();
  return exitCode === 0 && head !== undefined && COMMIT_ID.test(head) ? head : undefined;
};

export const USER_MEMORY_PATH_REFUSAL = 'a user memory belongs to no project, so it cannot be bound to a path';

export type BindMemoryEvidenceInput = {
  scope: MemoryScope;
  runId: string;
  paths: readonly string[];
  project: string;
  trusted: boolean;
  journal(paths: readonly string[]): Promise<EvidenceReply>;
  head(): Promise<string | undefined>;
};

export const bindMemoryEvidence = async (input: BindMemoryEvidenceInput): Promise<MemoryEvidence[]> => {
  if (input.scope === 'user') {
    if (input.paths.length > 0) throw new MemoryEvidenceError(USER_MEMORY_PATH_REFUSAL);
    return [];
  }
  const resolvedPaths = input.paths.map((given) => resolveToolPath(input.project, given));
  const facts = await input.journal(resolvedPaths);
  const bound = new Map<string, MemoryEvidence>();
  for (const [index, given] of input.paths.entries()) {
    const resolved = resolvedPaths[index];
    const recorded = facts.recorded[index];
    if (resolved === undefined || recorded === undefined) throw new Error(`the journal thread answered ${facts.recorded.length} recorded hashes for ${input.paths.length} paths`);
    if (!lexicallyWithin(resolved, input.project)) throw new MemoryEvidenceError(`${given} is outside the project, so a note cannot be bound to it`);
    if (recorded === null) throw new MemoryEvidenceError(`${given} was not read or written in this run, so a note cannot be bound to it. Read the file first.`);
    bound.set(resolved, { kind: 'file', project: input.project, path: path.relative(input.project, resolved), sha256: recorded.sha256 });
  }
  const commit = input.trusted ? await input.head() : undefined;
  const { check } = facts;
  return [
    ...bound.values(),
    ...(commit === undefined ? [] : [{ kind: 'commit' as const, sha: commit }]),
    ...(check === null ? [] : [{ kind: 'check' as const, runId: input.runId, ...check }]),
  ];
};
