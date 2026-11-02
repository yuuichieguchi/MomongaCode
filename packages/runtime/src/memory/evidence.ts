import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lexicallyWithin } from '@momonga/foundation';
import { EvidenceOutsideRootError } from '@momonga/memory';
import type { EvidencePorts } from '@momonga/memory';
import type { MemoryEvidence, RunEvent } from '@momonga/protocol';
import { ToolExecutionError } from '@momonga/tools';

export type EvidenceCommand = {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  network: 'deny';
};

export type EvidenceCommandResult = { exitCode: number | null; stdout?: string };

export type EvidenceRun = (command: EvidenceCommand) => Promise<EvidenceCommandResult>;

export type EvidencePortsOptions = { project: string; trusted: boolean; run: EvidenceRun };

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

const sha256OfFile = (target: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(target);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });

export const createEvidencePorts = ({ project, trusted, run }: EvidencePortsOptions): EvidencePorts => ({
  hashFile: async (absolutePath) => {
    let real: string;
    let root: string;
    try {
      root = await fs.promises.realpath(project);
      real = await fs.promises.realpath(absolutePath);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    if (!lexicallyWithin(real, root)) throw new EvidenceOutsideRootError(absolutePath);
    return sha256OfFile(real);
  },
  isAncestor: async (sha) => {
    if (!trusted || !COMMIT_ID.test(sha)) return undefined;
    const { exitCode } = await run(gitCommand(project, ['merge-base', '--is-ancestor', sha, 'HEAD']));
    if (exitCode === 0) return true;
    if (exitCode === 1) return false;
    return undefined;
  },
});

export const readGitHead = async ({ project, trusted, run }: EvidencePortsOptions): Promise<string | undefined> => {
  if (!trusted) return undefined;
  const { exitCode, stdout } = await run(gitCommand(project, ['rev-parse', 'HEAD']));
  const head = stdout?.trim();
  return exitCode === 0 && head !== undefined && COMMIT_ID.test(head) ? head : undefined;
};

export type BindMemoryEvidenceInput = {
  runId: string;
  events: readonly RunEvent[];
  paths: readonly string[];
  project: string;
  trusted: boolean;
  verificationCommands: readonly string[];
  head(): Promise<string | undefined>;
};

type FileEvent = Extract<RunEvent, { type: 'tool.completed' }>;

const latestRecordedHash = (events: readonly RunEvent[], resolved: string): { sha256: string; seq: number } | undefined => {
  let found: { sha256: string; seq: number } | undefined;
  for (const event of events) {
    if (event.type !== 'tool.completed') continue;
    const file = event.files?.find((candidate) => candidate.path === resolved);
    if (file !== undefined) found = { sha256: file.sha256, seq: event.seq };
  }
  return found;
};

const checkEvidenceOf = (input: BindMemoryEvidenceInput, boundPaths: ReadonlySet<string>): MemoryEvidence | undefined => {
  const commandOf = new Map<string, string>();
  for (const event of input.events) {
    if (event.type === 'tool.call' && event.name === 'Bash' && typeof event.rawInput === 'object' && event.rawInput !== null && 'command' in event.rawInput && typeof event.rawInput.command === 'string') {
      commandOf.set(event.callId, event.rawInput.command);
    }
  }
  const completed = input.events.filter((event): event is FileEvent => event.type === 'tool.completed');
  const lastWrite = Math.max(0, ...completed.filter((event) => event.files?.some((file) => file.access === 'write' && boundPaths.has(file.path)) === true).map((event) => event.seq));
  const matches = completed.filter((event) => {
    const command = commandOf.get(event.callId);
    return event.seq > lastWrite && event.exitCode !== undefined && command !== undefined && input.verificationCommands.includes(command);
  });
  const latest = matches.at(-1);
  if (latest === undefined || latest.exitCode === undefined) return undefined;
  const command = commandOf.get(latest.callId);
  if (command === undefined) return undefined;
  return { kind: 'check', runId: input.runId, callId: latest.callId, seq: latest.seq, command, exitCode: latest.exitCode };
};

export const bindMemoryEvidence = async (input: BindMemoryEvidenceInput): Promise<MemoryEvidence[]> => {
  if (input.paths.length === 0) return [];
  const bound = new Map<string, MemoryEvidence>();
  for (const given of input.paths) {
    const resolved = path.resolve(input.project, given);
    if (!lexicallyWithin(resolved, input.project)) throw new MemoryEvidenceError(`${given} is outside the project, so a note cannot be bound to it`);
    const recorded = latestRecordedHash(input.events, resolved);
    if (recorded === undefined) throw new MemoryEvidenceError(`${given} was not read or written in this run, so a note cannot be bound to it. Read the file first.`);
    bound.set(resolved, { kind: 'file', project: input.project, path: path.relative(input.project, resolved), sha256: recorded.sha256 });
  }
  const commit = input.trusted ? await input.head() : undefined;
  const check = checkEvidenceOf(input, new Set(bound.keys()));
  return [...bound.values(), ...(commit === undefined ? [] : [{ kind: 'commit' as const, sha: commit }]), ...(check === undefined ? [] : [check])];
};
