import { lexicallyWithin } from '@momonga/foundation';
import { EvidenceOutsideRootError, EvidenceUnreadableError } from '@momonga/memory';
import type { AddMemoryRequest, MemoryEvidence } from '@momonga/protocol';
import { MEMORY_TEXT_MAX_CHARS, memoryTextProblem } from '@momonga/tools';
import type { AddMemoryByCommandInput } from '@momonga/store';
import { MemoryEvidenceError, USER_MEMORY_PATH_REFUSAL, bindMemoryEvidence, createEvidencePorts, readGitHead } from './evidence.ts';
import type { BoundFacts, EvidenceRun } from './evidence.ts';

export class MemoryAddRefusal extends Error {
  readonly param: string | undefined;

  constructor(message: string, param?: string) {
    super(message);
    this.name = 'MemoryAddRefusal';
    this.param = param;
  }
}

export type MemoryAddContext = {
  trusted(project: string): boolean | Promise<boolean>;
  evidenceRun(project: string): EvidenceRun;
  signal: AbortSignal;
};

const hashedBy = (project: string, given: readonly string[], ports: ReturnType<typeof createEvidencePorts>) => async (resolved: readonly string[]): Promise<BoundFacts> => {
  const recorded = await Promise.all(
    resolved.map(async (target, index) => {
      if (!lexicallyWithin(target, project)) return null;
      const name = given[index];
      let sha256: string | undefined;
      try {
        sha256 = await ports.hashFile(target);
      } catch (error) {
        if (error instanceof EvidenceOutsideRootError) throw new MemoryAddRefusal(`${name} leaves the project through a link, so a memory cannot be bound to it`, 'paths');
        if (error instanceof EvidenceUnreadableError) throw new MemoryAddRefusal(`${name} cannot be read, so a memory cannot be bound to it`, 'paths');
        throw error;
      }
      if (sha256 === undefined) throw new MemoryAddRefusal(`${name} does not exist in the project or is not a regular file, so a memory cannot be bound to it`, 'paths');
      return { sha256 };
    }),
  );
  return { recorded, check: null };
};

export const prepareCommandMemory = async (request: AddMemoryRequest, context: MemoryAddContext): Promise<AddMemoryByCommandInput> => {
  const problem = memoryTextProblem(request.text);
  if (problem !== undefined) throw new MemoryAddRefusal(problem.message, 'text');
  if (request.text.length > MEMORY_TEXT_MAX_CHARS) throw new MemoryAddRefusal(`text is longer than ${MEMORY_TEXT_MAX_CHARS} characters`, 'text');
  const kind = request.kind === undefined ? {} : { kind: request.kind };
  const paths = request.paths ?? [];
  if (request.scope === 'user' && request.project !== undefined) throw new MemoryAddRefusal('a user memory belongs to no project, so project cannot be given', 'project');
  if (request.scope === 'project') {
    if (request.project === undefined) throw new MemoryAddRefusal('a project memory needs the project folder', 'project');
    if (!(await context.trusted(request.project))) {
      throw new MemoryAddRefusal(
        `${request.project} is not a trusted folder, so a project memory cannot be added there; trust the folder first or add a user memory`,
        'project',
      );
    }
  }
  const project = request.scope === 'project' ? (request.project ?? null) : null;
  const run = project === null ? undefined : context.evidenceRun(project);
  const ports = project === null || run === undefined ? undefined : createEvidencePorts({ project, trusted: true, run, signal: context.signal });
  let evidence: MemoryEvidence[];
  try {
    evidence = await bindMemoryEvidence({
      scope: request.scope,
      paths,
      project,
      trusted: true,
      facts: (resolved) => {
        if (project === null || ports === undefined) throw new Error('a user memory has no journal to ask');
        return hashedBy(project, paths, ports)(resolved);
      },
      head: () => {
        if (project === null || run === undefined) throw new Error('a user memory has no head to read');
        return readGitHead({ project, trusted: true, run, signal: context.signal });
      },
    });
  } catch (error) {
    if (error instanceof MemoryEvidenceError) throw new MemoryAddRefusal(error.message, 'paths');
    throw error;
  }
  return { scope: request.scope, project, text: request.text, evidence, ...kind };
};
