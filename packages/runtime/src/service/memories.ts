import type { Context } from 'hono';
import { MEMORY_SCOPES, MEMORY_STATES } from '@momonga/protocol';
import type { AddMemoryRequest, MemoryScope, MemoryState, PromoteMemoryRequest, ReflectionResponse, RunReflectionView } from '@momonga/protocol';
import { isValidSkillName } from '@momonga/skills';
import type { MemoryChange, RuntimeStore } from '@momonga/store';
import { MemoryAddRefusal, prepareCommandMemory } from '../memory/add-memory.ts';
import type { EvidenceRun } from '../memory/evidence.ts';
import { writeSkillFile } from '../memory/skill-promotion.ts';
import type { RecordViews } from '../memory/views.ts';
import { conflict, invalidRequest, notFound } from './errors.ts';
import type { Handler, RouteRegistrar } from './app.ts';
import { canonicalProject } from './project-query.ts';
import { JSON_MEDIA_TYPES, readJson, validateBody } from './request.ts';

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const scopeOf = (raw: string | undefined): MemoryScope | undefined => {
  if (raw === undefined) return undefined;
  const scope = MEMORY_SCOPES.find((candidate) => candidate === raw);
  if (scope === undefined) throw invalidRequest(`scope must be one of ${MEMORY_SCOPES.join(', ')}`, 'scope');
  return scope;
};

const stateOf = (raw: string | undefined): MemoryState | undefined => {
  if (raw === undefined) return undefined;
  const state = MEMORY_STATES.find((candidate) => candidate === raw);
  if (state === undefined) throw invalidRequest(`state must be one of ${MEMORY_STATES.join(', ')}`, 'state');
  return state;
};

const projectOf = (raw: string | undefined): string | undefined => (raw === undefined ? undefined : canonicalProject(raw, 'project'));

export type MemoryRoutesDeps = {
  store: Pick<RuntimeStore, 'memories' | 'reflection' | 'trust' | 'contextCharges'>;
  views: RecordViews;
  evidenceRun: (project: string) => EvidenceRun;
  maxBodyBytes: number;
  closeSignal: AbortSignal;
  home: string;
};

export const registerMemoryRoutes = (route: RouteRegistrar, deps: MemoryRoutesDeps): void => {
  const { memories, reflection, trust } = deps.store;
  const { views } = deps;
  const boundOf = (context: Context): AbortSignal => AbortSignal.any([deps.closeSignal, context.req.raw.signal]);

  const requireMemory = (context: Context) => {
    const id = context.req.param('id') ?? '';
    const memory = memories.get(id);
    if (memory === undefined) throw notFound(`memory ${id} does not exist`);
    return memory;
  };

  const listMemories: Handler = async (context) => {
    const scope = scopeOf(context.req.query('scope'));
    const project = projectOf(context.req.query('project'));
    if (project !== undefined && scope === 'user') throw invalidRequest('a project filter cannot be combined with the user scope', 'project');
    const state = stateOf(context.req.query('state'));
    const found = memories
      .list({ ...(scope === undefined ? {} : { scope }), ...(project === undefined ? {} : { project }) })
      .filter((memory) => (state === undefined ? memory.state !== 'candidate' : memory.state === state));
    return json({ memories: await views.viewsOf(found, boundOf(context)) }, 200);
  };

  const changed = async (context: Context, result: MemoryChange<string, string>, done: string, requirement: string): Promise<Response> => {
    const id = context.req.param('id') ?? '';
    if (result.memory === undefined) throw notFound(`memory ${id} does not exist`);
    if (result.kind !== done) throw conflict('memory_state', `memory ${id} is ${result.memory.state}, not ${requirement}`);
    return json({ memory: await views.viewOf(result.memory, boundOf(context)) }, 200);
  };

  const acceptMemory: Handler = (context) => changed(context, memories.accept(context.req.param('id') ?? ''), 'accepted', 'a candidate');

  const rejectMemory: Handler = (context) => changed(context, memories.reject(context.req.param('id') ?? ''), 'rejected', 'a candidate');

  const restoreMemory: Handler = (context) => changed(context, memories.restore(context.req.param('id') ?? ''), 'restored', 'archived');

  const promoteMemory: Handler = async (context) => {
    const memory = requireMemory(context);
    const body = validateBody<PromoteMemoryRequest>('PromoteMemoryRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    if (!isValidSkillName(body.skill)) {
      throw invalidRequest('skill must be 1 to 64 lowercase letters, digits and single hyphens that neither start nor end the name', 'skill');
    }
    if (memory.state !== 'active' || memory.retiredAt !== null) throw conflict('memory_state', `memory ${memory.id} is ${memory.state}, and only an accepted memory can become a skill`);
    if (memory.kind !== 'procedure') throw conflict('memory_state', `memory ${memory.id} is a ${memory.kind}, and only a procedure can become a skill`);
    if (memory.origin !== 'trusted') throw conflict('memory_state', `memory ${memory.id} was saved at an untrusted origin, and only a memory of a trusted origin can become a skill`);
    const written = await writeSkillFile({ root: memory.project ?? deps.home, name: body.skill, text: memory.text });
    if (written.kind === 'written') return json({ path: written.path }, 201);
    if (written.kind === 'exists') throw conflict('skill_target', `${written.path} already exists, so it is not overwritten`);
    if (written.kind === 'symlink') throw conflict('skill_target', `${written.path} is a symbolic link, so nothing is written through it`);
    throw conflict('skill_target', `${written.path} is not a directory, so the skill cannot be written there`);
  };

  const addMemory: Handler = async (context) => {
    const body = validateBody<AddMemoryRequest>('AddMemoryRequest', await readJson(context.req.raw, JSON_MEDIA_TYPES, deps.maxBodyBytes));
    const request: AddMemoryRequest = body.project === undefined ? body : { ...body, project: canonicalProject(body.project, 'project') };
    try {
      const prepared = await prepareCommandMemory(request, {
        trusted: (project) => trust.decisionFor(project).decision === 'trusted',
        evidenceRun: deps.evidenceRun,
        signal: boundOf(context),
      });
      return json({ memory: await views.viewOf(memories.addByCommand(prepared), boundOf(context)) }, 201);
    } catch (error) {
      if (error instanceof MemoryAddRefusal) throw invalidRequest(error.message, error.param);
      throw error;
    }
  };

  const getMemory: Handler = async (context) => json({ memory: await views.viewOf(requireMemory(context), boundOf(context)) }, 200);

  const memoryHistory: Handler = async (context) => {
    const memory = requireMemory(context);
    return json({ memories: await views.viewsOf(memories.history(memory.id), boundOf(context)) }, 200);
  };

  const deleteMemory: Handler = (context) => {
    const id = context.req.param('id') ?? '';
    if (!memories.delete(id)) throw notFound(`memory ${id} does not exist`);
    return new Response(null, { status: 204 });
  };

  const latestReflection: Handler = (context) => {
    const raw = context.req.query('project');
    if (raw === undefined) throw invalidRequest('project is required', 'project');
    const job = reflection.latestForProject(canonicalProject(raw, 'project'));
    const view: ReflectionResponse = {
      job: job === undefined ? null : { runId: job.runId, state: job.state, attempts: job.attempts, reason: job.lastError, dropped: job.dropped, updatedAt: job.updatedAt },
    };
    return json(view, 200);
  };

  const reflectionOfRun: Handler = (context) => {
    const runId = context.req.param('id') ?? '';
    const job = reflection.get(runId);
    const view: RunReflectionView = {
      job: job === undefined ? null : { runId: job.runId, state: job.state, attempts: job.attempts, reason: job.lastError, dropped: job.dropped, updatedAt: job.updatedAt },
      charges: deps.store.contextCharges.list({ runIds: [runId] }).filter((entry) => entry.purpose === 'reflection'),
      queuedAhead: job === undefined ? 0 : reflection.aheadOf(runId),
    };
    return json(view, 200);
  };

  route('/v1/reflection', { GET: latestReflection });
  route('/v1/runs/:id/reflection', { GET: reflectionOfRun });
  route('/v1/memories', { GET: listMemories, POST: addMemory });
  route('/v1/memories/:id', { GET: getMemory, DELETE: deleteMemory });
  route('/v1/memories/:id/history', { GET: memoryHistory });
  route('/v1/memories/:id/accept', { POST: acceptMemory });
  route('/v1/memories/:id/reject', { POST: rejectMemory });
  route('/v1/memories/:id/restore', { POST: restoreMemory });
  route('/v1/memories/:id/promote', { POST: promoteMemory });
};
