import type { Context } from 'hono';
import { MEMORY_SCOPES } from '@momonga/protocol';
import type { AddMemoryRequest, MemoryScope } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import { MemoryAddRefusal, prepareCommandMemory } from '../memory/add-memory.ts';
import type { EvidenceRun } from '../memory/evidence.ts';
import type { RecordViews } from '../memory/views.ts';
import { invalidRequest, notFound } from './errors.ts';
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

const projectOf = (raw: string | undefined): string | undefined => (raw === undefined ? undefined : canonicalProject(raw, 'project'));

export type MemoryRoutesDeps = {
  store: Pick<RuntimeStore, 'memories' | 'trust'>;
  views: RecordViews;
  evidenceRun: (project: string) => EvidenceRun;
  maxBodyBytes: number;
  closeSignal: AbortSignal;
};

export const registerMemoryRoutes = (route: RouteRegistrar, deps: MemoryRoutesDeps): void => {
  const { memories, trust } = deps.store;
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
    const found = memories.list({ ...(scope === undefined ? {} : { scope }), ...(project === undefined ? {} : { project }) });
    return json({ memories: await views.viewsOf(found, boundOf(context)) }, 200);
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

  route('/v1/memories', { GET: listMemories, POST: addMemory });
  route('/v1/memories/:id', { GET: getMemory, DELETE: deleteMemory });
  route('/v1/memories/:id/history', { GET: memoryHistory });
};
