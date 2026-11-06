import path from 'node:path';
import { lexicallyWithin, resolveToolPath } from '@momonga/foundation';
import { EvidenceOutsideRootError, EvidenceUnreadableError } from '@momonga/memory';
import type { AddMemoryRequest, MemoryEvidence } from '@momonga/protocol';
import { MEMORY_TEXT_MAX_CHARS, memoryTextProblem } from '@momonga/tools';
import type { AddMemoryByCommandInput } from '@momonga/store';
import { USER_MEMORY_PATH_REFUSAL, createEvidencePorts, readGitHead } from './evidence.ts';
import type { EvidenceRun } from './evidence.ts';

export class MemoryAddRefusal extends Error {
  readonly param: string | undefined;

  constructor(message: string, param?: string) {
    super(message);
    this.name = 'MemoryAddRefusal';
    this.param = param;
  }
}

export type MemoryAddContext = {
  trusted(project: string): boolean;
  evidenceRun(project: string): EvidenceRun;
  signal: AbortSignal;
};

const fileEvidenceOf = async (project: string, given: string, ports: ReturnType<typeof createEvidencePorts>): Promise<MemoryEvidence> => {
  const resolved = resolveToolPath(project, given);
  if (!lexicallyWithin(resolved, project)) throw new MemoryAddRefusal(`${given} is outside the project, so a memory cannot be bound to it`, 'paths');
  let sha256: string | undefined;
  try {
    sha256 = await ports.hashFile(resolved);
  } catch (error) {
    if (error instanceof EvidenceOutsideRootError) throw new MemoryAddRefusal(`${given} leaves the project through a link, so a memory cannot be bound to it`, 'paths');
    if (error instanceof EvidenceUnreadableError) throw new MemoryAddRefusal(`${given} cannot be read, so a memory cannot be bound to it`, 'paths');
    throw error;
  }
  if (sha256 === undefined) throw new MemoryAddRefusal(`${given} does not exist in the project or is not a regular file, so a memory cannot be bound to it`, 'paths');
  return { kind: 'file', project, path: path.relative(project, resolved), sha256 };
};

export const prepareCommandMemory = async (request: AddMemoryRequest, context: MemoryAddContext): Promise<AddMemoryByCommandInput> => {
  const problem = memoryTextProblem(request.text);
  if (problem !== undefined) throw new MemoryAddRefusal(problem.message, 'text');
  if (request.text.length > MEMORY_TEXT_MAX_CHARS) throw new MemoryAddRefusal(`text is longer than ${MEMORY_TEXT_MAX_CHARS} characters`, 'text');
  const kind = request.kind === undefined ? {} : { kind: request.kind };
  const paths = request.paths ?? [];
  if (request.scope === 'user') {
    if (request.project !== undefined) throw new MemoryAddRefusal('a user memory belongs to no project, so project cannot be given', 'project');
    if (paths.length > 0) throw new MemoryAddRefusal(USER_MEMORY_PATH_REFUSAL, 'paths');
    return { scope: 'user', project: null, text: request.text, evidence: [], ...kind };
  }
  const { project } = request;
  if (project === undefined) throw new MemoryAddRefusal('a project memory needs the project folder', 'project');
  if (!context.trusted(project)) {
    throw new MemoryAddRefusal(`${project} is not a trusted folder, so a project memory cannot be added there; trust the folder first or add a user memory`, 'project');
  }
  const ports = createEvidencePorts({ project, trusted: true, run: context.evidenceRun(project), signal: context.signal });
  const files = await Promise.all(paths.map((given) => fileEvidenceOf(project, given, ports)));
  const head = await readGitHead({ project, trusted: true, run: context.evidenceRun(project), signal: context.signal });
  return { scope: 'project', project, text: request.text, evidence: [...files, ...(head === undefined ? [] : [{ kind: 'commit' as const, sha: head }])], ...kind };
};
