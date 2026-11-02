import type { Context } from 'hono';
import { MEMORY_SCOPES } from '@momonga/protocol';
import type { MemoryScope } from '@momonga/protocol';
import type { RuntimeStore } from '@momonga/store';
import type { RecordViews } from '../memory/views.ts';
import { invalidRequest, notFound } from './errors.ts';
import type { Handler, RouteRegistrar } from './app.ts';
import { canonicalProject } from './project-query.ts';

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const scopeOf = (raw: string | undefined): MemoryScope | undefined => {
  if (raw === undefined) return undefined;
  const scope = MEMORY_SCOPES.find((candidate) => candidate === raw);
  if (scope === undefined) throw invalidRequest(`scope must be one of ${MEMORY_SCOPES.join(', ')}`, 'scope');
  return scope;
};

const projectOf = (raw: string | undefined): string | undefined => (raw === undefined ? undefined : canonicalProject(raw, 'project'));

export const registerMemoryRoutes = (route: RouteRegistrar, deps: { store: Pick<RuntimeStore, 'memories'>; views: RecordViews; closeSignal: AbortSignal }): void => {
  const { memories } = deps.store;
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

  route('/v1/memories', { GET: listMemories });
  route('/v1/memories/:id', { GET: getMemory, DELETE: deleteMemory });
  route('/v1/memories/:id/history', { GET: memoryHistory });
};
